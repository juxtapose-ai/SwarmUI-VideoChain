using Newtonsoft.Json.Linq;
using SwarmUI.Accounts;
using SwarmUI.Core;
using SwarmUI.Utils;
using SwarmUI.WebAPI;
using System.IO;

namespace SwarmExtensions.VideoChain;

/// <summary>Extension for iterative video chain generation with side-by-side comparison.</summary>
public class VideoChain : Extension
{
    /// <summary>Gets the base output directory (absolute path).</summary>
    public static string BaseOutputDir => Utilities.CombinePathWithAbsolute(Environment.CurrentDirectory, Program.ServerSettings.Paths.OutputPath);

    /// <summary>Gets the VideoChain directory for a specific user (for both chain JSONs and stitched videos).</summary>
    public static string GetUserVideoChainDir(string userId)
    {
        if (Program.ServerSettings.Paths.AppendUserNameToOutputPath && !string.IsNullOrEmpty(userId))
        {
            return Path.Combine(BaseOutputDir, userId, "VideoChains");
        }
        return Path.Combine(BaseOutputDir, "VideoChains");
    }

    public static PermInfo PermGenerateVideoChains = Permissions.Register(new(
        "videochain_generate",
        "[Video Chain] Generate Video Chains",
        "Allows the user to create and generate video chains.",
        PermissionDefault.USER,
        Permissions.GroupUser
    ));

    public static PermInfo PermManageVideoChains = Permissions.Register(new(
        "videochain_manage",
        "[Video Chain] Manage Video Chains",
        "Allows the user to edit, delete, and stitch video chains.",
        PermissionDefault.USER,
        Permissions.GroupUser
    ));

    public override void OnPreInit()
    {
        ScriptFiles.Add("Assets/video_chain.js");
        StyleSheetFiles.Add("Assets/video_chain.css");
    }

    public override void OnInit()
    {
        Logs.Init("VideoChain extension loaded!");

        // Register API endpoints
        API.RegisterAPICall(CreateVideoChain, true, PermGenerateVideoChains);
        API.RegisterAPICall(GetVideoChain, false, PermGenerateVideoChains);
        API.RegisterAPICall(ListVideoChains, false, PermGenerateVideoChains);
        API.RegisterAPICall(UpdateChainSegment, true, PermManageVideoChains);
        API.RegisterAPICall(DeleteChainCandidates, true, PermManageVideoChains);
        API.RegisterAPICall(StitchChain, true, PermManageVideoChains);
        API.RegisterAPICall(DeleteChain, true, PermManageVideoChains);
        API.RegisterAPICall(AddChainCandidates, true, PermGenerateVideoChains);
        API.RegisterAPICall(UpdateChainStatus, true, PermGenerateVideoChains);
    }

    /// <summary>Gets the chain file path for a given chain ID and user.</summary>
    public static string GetChainFilePath(string userId, string chainId)
    {
        string cleanId = Utilities.StrictFilenameClean(chainId);
        return Path.Combine(GetUserVideoChainDir(userId), $"{cleanId}.json");
    }

    /// <summary>Converts a stored video path (URL format) to a full file system path.</summary>
    public static string GetFullPathFromStoredPath(string storedPath)
    {
        // URL format is: View/{username}/raw/{date}/{filename}
        // File path is: {OutputPath}/{username}/raw/{date}/{filename}
        // So we just need to strip "View/" prefix
        string relativePath = storedPath;

        // Strip leading "View/" if present
        if (relativePath.StartsWith("View/"))
        {
            relativePath = relativePath["View/".Length..];
        }

        string outputPath = Utilities.CombinePathWithAbsolute(Environment.CurrentDirectory, Program.ServerSettings.Paths.OutputPath);
        return Path.Combine(outputPath, relativePath.Replace('/', Path.DirectorySeparatorChar));
    }

    /// <summary>Loads a chain from disk.</summary>
    public static JObject LoadChain(string userId, string chainId)
    {
        string path = GetChainFilePath(userId, chainId);
        if (!File.Exists(path))
        {
            return null;
        }
        return JObject.Parse(File.ReadAllText(path));
    }

    /// <summary>Saves a chain to disk.</summary>
    public static void SaveChain(string userId, string chainId, JObject chain)
    {
        string dir = GetUserVideoChainDir(userId);
        Directory.CreateDirectory(dir);
        string path = GetChainFilePath(userId, chainId);
        File.WriteAllText(path, chain.ToString(Newtonsoft.Json.Formatting.Indented));
    }

    /// <summary>Creates a new video chain.</summary>
    public async Task<JObject> CreateVideoChain(Session session, string name, int candidatesPerSegment = 5)
    {
        string chainId = $"chain_{DateTime.UtcNow:yyyyMMdd_HHmmss}_{Guid.NewGuid().ToString()[..8]}";
        string chainName = string.IsNullOrWhiteSpace(name) ? chainId : Utilities.StrictFilenameClean(name);

        JObject chain = new()
        {
            ["chain_id"] = chainId,
            ["name"] = chainName,
            ["created"] = DateTime.UtcNow.ToString("o"),
            ["status"] = "in_progress",
            ["candidates_per_segment"] = candidatesPerSegment,
            ["user_id"] = session.User.UserID,
            ["segments"] = new JArray()
        };

        SaveChain(session.User.UserID, chainId, chain);

        return new JObject()
        {
            ["success"] = true,
            ["chain_id"] = chainId,
            ["chain"] = chain
        };
    }

    /// <summary>Gets a video chain by ID.</summary>
    public async Task<JObject> GetVideoChain(Session session, string chainId)
    {
        // Try user's own chains first, then check if admin accessing another user's chain
        JObject chain = LoadChain(session.User.UserID, chainId);
        if (chain == null && session.User.HasPermission(Permissions.ManageUsers))
        {
            // Admin might be accessing another user's chain - scan all user directories
            // For now, just return not found - admins can use the list view
            return new JObject() { ["error"] = "Chain not found" };
        }
        if (chain == null)
        {
            return new JObject() { ["error"] = "Chain not found" };
        }

        return new JObject()
        {
            ["success"] = true,
            ["chain"] = chain
        };
    }

    /// <summary>Lists all video chains for the current user.</summary>
    public async Task<JObject> ListVideoChains(Session session)
    {
        List<JObject> chainList = [];
        string userChainDir = GetUserVideoChainDir(session.User.UserID);

        if (Directory.Exists(userChainDir))
        {
            foreach (string file in Directory.GetFiles(userChainDir, "*.json"))
            {
                try
                {
                    JObject chain = JObject.Parse(File.ReadAllText(file));

                    // Get first video from first segment for thumbnail
                    string firstVideo = null;
                    JArray segments = chain["segments"] as JArray;
                    if (segments != null && segments.Count > 0)
                    {
                        JObject firstSegment = segments[0] as JObject;
                        JArray candidates = firstSegment?["candidates"] as JArray;
                        if (candidates != null && candidates.Count > 0)
                        {
                            firstVideo = candidates[0]?.ToString();
                        }
                    }

                    // Check if last segment has a selection
                    bool lastSegmentHasSelection = false;
                    if (segments != null && segments.Count > 0)
                    {
                        JObject lastSegment = segments[segments.Count - 1] as JObject;
                        lastSegmentHasSelection = !string.IsNullOrEmpty(lastSegment?["selected_video"]?.ToString());
                    }

                    chainList.Add(new JObject()
                    {
                        ["chain_id"] = chain["chain_id"],
                        ["name"] = chain["name"],
                        ["created"] = chain["created"],
                        ["status"] = chain["status"],
                        ["segment_count"] = segments?.Count ?? 0,
                        ["first_video"] = firstVideo,
                        ["last_segment_has_selection"] = lastSegmentHasSelection
                    });
                }
                catch (Exception ex)
                {
                    Logs.Warning($"Failed to read chain file {file}: {ex.Message}");
                }
            }
        }

        // Sort by created date descending (newest first)
        chainList.Sort((a, b) => string.Compare(b["created"]?.ToString(), a["created"]?.ToString(), StringComparison.Ordinal));

        return new JObject()
        {
            ["success"] = true,
            ["chains"] = new JArray(chainList)
        };
    }

    /// <summary>Updates a chain's status.</summary>
    public async Task<JObject> UpdateChainStatus(Session session, string chainId, string status)
    {
        JObject chain = LoadChain(session.User.UserID, chainId);
        if (chain == null)
        {
            return new JObject() { ["error"] = "Chain not found" };
        }

        chain["status"] = status;
        SaveChain(session.User.UserID, chainId, chain);

        return new JObject()
        {
            ["success"] = true,
            ["chain"] = chain
        };
    }

    /// <summary>Adds candidates to a chain segment.</summary>
    public async Task<JObject> AddChainCandidates(Session session, string chainId, int segmentIndex, string[] candidates, string initImage = null, string prompt = null)
    {
        JObject chain = LoadChain(session.User.UserID, chainId);
        if (chain == null)
        {
            return new JObject() { ["error"] = "Chain not found" };
        }

        JArray segments = (JArray)chain["segments"];

        // Expand segments array if needed
        while (segments.Count <= segmentIndex)
        {
            segments.Add(new JObject()
            {
                ["segment_index"] = segments.Count,
                ["selected_video"] = null,
                ["candidates"] = new JArray(),
                ["init_image"] = null,
                ["prompt"] = null
            });
        }

        JObject segment = (JObject)segments[segmentIndex];
        JArray existingCandidates = (JArray)segment["candidates"];

        foreach (string candidate in candidates)
        {
            existingCandidates.Add(candidate);
        }

        if (initImage != null)
        {
            segment["init_image"] = initImage;
        }
        if (prompt != null)
        {
            segment["prompt"] = prompt;
        }

        SaveChain(session.User.UserID, chainId, chain);

        return new JObject()
        {
            ["success"] = true,
            ["chain"] = chain
        };
    }

    /// <summary>Updates a chain segment with selection.</summary>
    public async Task<JObject> UpdateChainSegment(Session session, string chainId, int segmentIndex, string selectedVideo)
    {
        JObject chain = LoadChain(session.User.UserID, chainId);
        if (chain == null)
        {
            return new JObject() { ["error"] = "Chain not found" };
        }

        JArray segments = (JArray)chain["segments"];
        if (segmentIndex >= segments.Count)
        {
            return new JObject() { ["error"] = "Segment not found" };
        }

        JObject segment = (JObject)segments[segmentIndex];
        segment["selected_video"] = selectedVideo;

        SaveChain(session.User.UserID, chainId, chain);

        return new JObject()
        {
            ["success"] = true,
            ["chain"] = chain
        };
    }

    /// <summary>Deletes non-selected candidates from a segment.</summary>
    public async Task<JObject> DeleteChainCandidates(Session session, string chainId, int segmentIndex)
    {
        JObject chain = LoadChain(session.User.UserID, chainId);
        if (chain == null)
        {
            return new JObject() { ["error"] = "Chain not found" };
        }

        JArray segments = (JArray)chain["segments"];
        if (segmentIndex >= segments.Count)
        {
            return new JObject() { ["error"] = "Segment not found" };
        }

        JObject segment = (JObject)segments[segmentIndex];
        string selectedVideo = segment["selected_video"]?.ToString();

        if (string.IsNullOrEmpty(selectedVideo))
        {
            return new JObject() { ["error"] = "No video selected yet" };
        }

        JArray candidates = (JArray)segment["candidates"];
        List<string> deleted = [];

        foreach (JToken candidate in candidates.ToList())
        {
            string candidatePath = candidate.ToString();
            if (candidatePath != selectedVideo)
            {
                // Try to delete the video file and all related sidecar files
                string fullPath = GetFullPathFromStoredPath(candidatePath);
                if (File.Exists(fullPath))
                {
                    try
                    {
                        string directory = Path.GetDirectoryName(fullPath);
                        string fileNameWithoutExt = Path.GetFileNameWithoutExtension(fullPath);

                        // Delete the main video file
                        Utilities.SendFileToRecycle(fullPath);
                        deleted.Add(candidatePath);

                        // Delete all sidecar files (files starting with same name)
                        // This catches: video.mp4.json, video.txt, video-1.png, etc.
                        if (directory != null)
                        {
                            foreach (string sidecarFile in Directory.GetFiles(directory, $"{fileNameWithoutExt}*"))
                            {
                                // Skip if it's the main file we already deleted
                                if (sidecarFile == fullPath) continue;

                                try
                                {
                                    Utilities.SendFileToRecycle(sidecarFile);
                                }
                                catch (Exception ex)
                                {
                                    Logs.Warning($"Failed to delete sidecar file {sidecarFile}: {ex.Message}");
                                }
                            }
                        }
                    }
                    catch (Exception ex)
                    {
                        Logs.Warning($"Failed to delete candidate {candidatePath}: {ex.Message}");
                    }
                }
            }
        }

        // Update candidates list to only include selected
        segment["candidates"] = new JArray { selectedVideo };
        SaveChain(session.User.UserID, chainId, chain);

        return new JObject()
        {
            ["success"] = true,
            ["deleted"] = JArray.FromObject(deleted),
            ["chain"] = chain
        };
    }

    /// <summary>Stitches all selected segments into a final video using FFmpeg.</summary>
    public async Task<JObject> StitchChain(Session session, string chainId)
    {
        JObject chain = LoadChain(session.User.UserID, chainId);
        if (chain == null)
        {
            return new JObject() { ["error"] = "Chain not found" };
        }

        string ffmpeg = Utilities.FfmegLocation.Value;
        if (string.IsNullOrEmpty(ffmpeg))
        {
            return new JObject() { ["error"] = "FFmpeg not available" };
        }

        JArray segments = (JArray)chain["segments"];
        List<string> selectedVideos = [];
        List<string> promptChain = [];

        foreach (JObject segment in segments)
        {
            string selected = segment["selected_video"]?.ToString();
            if (!string.IsNullOrEmpty(selected))
            {
                string fullPath = GetFullPathFromStoredPath(selected);
                if (File.Exists(fullPath))
                {
                    selectedVideos.Add(fullPath);

                    // Try to get the parsed prompt from the sidecar JSON
                    string sidecarPath = fullPath + ".json";
                    string prompt = segment["prompt"]?.ToString() ?? "";
                    if (File.Exists(sidecarPath))
                    {
                        try
                        {
                            JObject sidecar = JObject.Parse(File.ReadAllText(sidecarPath));
                            // Use parsed prompt from sidecar if available (after wildcards/randoms resolved)
                            prompt = sidecar["prompt"]?.ToString() ?? prompt;
                        }
                        catch { }
                    }
                    promptChain.Add(prompt);
                }
                else
                {
                    Logs.Warning($"VideoChain: Selected video not found: {fullPath}");
                }
            }
        }

        if (selectedVideos.Count == 0)
        {
            return new JObject() { ["error"] = "No videos selected" };
        }

        // Create concat file and output paths
        string chainName = chain["name"]?.ToString() ?? chainId;
        string userVideoDir = GetUserVideoChainDir(session.User.UserID);
        Directory.CreateDirectory(userVideoDir);
        string concatFilePath = Path.Combine(Path.GetTempPath(), $"{chainId}_concat.txt");
        string outputPath = Path.Combine(userVideoDir, $"{Utilities.StrictFilenameClean(chainName)}_final.mp4");

        // Write concat file with proper escaping for FFmpeg
        File.WriteAllLines(concatFilePath, selectedVideos.Select(v => $"file '{v.Replace("\\", "/").Replace("'", "'\\''")}'"));

        try
        {
            string[] args = ["-y", "-f", "concat", "-safe", "0", "-i", concatFilePath, "-c", "copy", outputPath];
            string result = await Utilities.QuickRunProcess(ffmpeg, args);

            // Clean up concat file
            if (File.Exists(concatFilePath))
            {
                File.Delete(concatFilePath);
            }

            // Verify output was created
            if (!File.Exists(outputPath))
            {
                Logs.Warning($"FFmpeg output: {result}");
                return new JObject() { ["error"] = "FFmpeg did not produce output file" };
            }

            // Update chain status
            chain["status"] = "stitched";
            // Store relative path for serving via View endpoint
            // View endpoint expects: View/{user}/{path} where path is relative to Output/{user}/
            // Output file is at: Output/{user}/raw/VideoChains/file.mp4
            // So relativePath should be: raw/VideoChains/file.mp4
            string userOutputDir = Path.Combine(BaseOutputDir, session.User.UserID).Replace("\\", "/");
            string relativePath = outputPath.Replace("\\", "/");
            if (relativePath.StartsWith(userOutputDir))
            {
                relativePath = relativePath[(userOutputDir.Length + 1)..];
            }
            chain["final_output"] = relativePath;
            // Store the full prompt chain (parsed prompts from all selected segments)
            chain["prompt_chain"] = JArray.FromObject(promptChain);
            SaveChain(session.User.UserID, chainId, chain);

            return new JObject()
            {
                ["success"] = true,
                ["output"] = chain["final_output"],
                ["chain"] = chain
            };
        }
        catch (Exception ex)
        {
            Logs.Error($"FFmpeg stitch failed: {ex.Message}");
            return new JObject() { ["error"] = $"FFmpeg failed: {ex.Message}" };
        }
    }

    /// <summary>Deletes a chain and optionally its videos.</summary>
    public async Task<JObject> DeleteChain(Session session, string chainId, bool deleteVideos = false)
    {
        JObject chain = LoadChain(session.User.UserID, chainId);
        if (chain == null)
        {
            return new JObject() { ["error"] = "Chain not found" };
        }

        if (deleteVideos)
        {
            JArray segments = (JArray)chain["segments"];
            foreach (JObject segment in segments)
            {
                JArray candidates = (JArray)segment["candidates"];
                foreach (JToken candidate in candidates)
                {
                    string fullPath = GetFullPathFromStoredPath(candidate.ToString());
                    if (File.Exists(fullPath))
                    {
                        try
                        {
                            string directory = Path.GetDirectoryName(fullPath);
                            string fileNameWithoutExt = Path.GetFileNameWithoutExtension(fullPath);

                            // Delete the main video file
                            Utilities.SendFileToRecycle(fullPath);

                            // Delete all sidecar files (files starting with same name)
                            // This catches: video.mp4.json, video.txt, video-1.png, etc.
                            if (directory != null)
                            {
                                foreach (string sidecarFile in Directory.GetFiles(directory, $"{fileNameWithoutExt}*"))
                                {
                                    if (sidecarFile == fullPath) continue;
                                    try
                                    {
                                        Utilities.SendFileToRecycle(sidecarFile);
                                    }
                                    catch { }
                                }
                            }
                        }
                        catch (Exception ex)
                        {
                            Logs.Warning($"Failed to delete video {candidate}: {ex.Message}");
                        }
                    }
                }
            }

            // Delete final output if exists
            string finalOutput = chain["final_output"]?.ToString();
            if (!string.IsNullOrEmpty(finalOutput))
            {
                string fullPath = GetFullPathFromStoredPath(finalOutput);
                if (File.Exists(fullPath))
                {
                    try
                    {
                        Utilities.SendFileToRecycle(fullPath);
                    }
                    catch { }
                }
            }
        }

        // Delete chain file
        string chainPath = GetChainFilePath(session.User.UserID, chainId);
        if (File.Exists(chainPath))
        {
            File.Delete(chainPath);
        }

        return new JObject() { ["success"] = true };
    }
}
