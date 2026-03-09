using Newtonsoft.Json.Linq;
using SwarmUI.Accounts;
using SwarmUI.Core;
using SwarmUI.Utils;
using SwarmUI.WebAPI;
using System.Collections.Concurrent;
using System.IO;
using System.Linq;
using System.Threading.Tasks;

namespace SwarmExtensions.VideoChain;

/// <summary>Extension for iterative video chain generation with side-by-side comparison.</summary>
public class VideoChain : Extension
{
    /// <summary>Locks for chain file access to prevent race conditions.</summary>
    private static readonly ConcurrentDictionary<string, object> ChainLocks = new();

    /// <summary>Watches the output directory for new .swarm.json sidecar files to update chains in real-time.</summary>
    private FileSystemWatcher _outputWatcher;

    /// <summary>Gets or creates a lock object for a specific chain.</summary>
    private static object GetChainLock(string chainId) => ChainLocks.GetOrAdd(chainId, _ => new object());

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

    /// <summary>Registers a permission, or returns the existing one if already registered (guards against duplicate extension loads).</summary>
    private static PermInfo RegisterOrGetPerm(PermInfo perm) =>
        Permissions.Registered.TryGetValue(perm.ID, out PermInfo existing) ? existing : Permissions.Register(perm);

    public static PermInfo PermGenerateVideoChains = RegisterOrGetPerm(new(
        "videochain_generate",
        "[Video Chain] Generate Video Chains",
        "Allows the user to create and generate video chains.",
        PermissionDefault.USER,
        Permissions.GroupUser
    ));

    public static PermInfo PermManageVideoChains = RegisterOrGetPerm(new(
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
        API.RegisterAPICall(PollChainProgress, false, PermGenerateVideoChains);

        StartOutputWatcher();
    }

    /// <summary>Clean up the file watcher on shutdown.</summary>
    public override void OnShutdown()
    {
        _outputWatcher?.Dispose();
        _outputWatcher = null;
    }

    /// <summary>Starts a FileSystemWatcher on the output directory to detect new .swarm.json sidecars.</summary>
    private void StartOutputWatcher()
    {
        string watchDir = BaseOutputDir;
        if (!Directory.Exists(watchDir))
        {
            Logs.Warning("VideoChain: Output directory does not exist, file watcher not started.");
            return;
        }
        _outputWatcher = new FileSystemWatcher(watchDir)
        {
            Filter = "*.json",
            IncludeSubdirectories = true,
            NotifyFilter = NotifyFilters.FileName,
            EnableRaisingEvents = true
        };
        _outputWatcher.Created += (_, e) =>
        {
            if (!e.FullPath.EndsWith(".swarm.json", StringComparison.OrdinalIgnoreCase)) return;
            // Small delay to ensure WriteAllBytes has fully flushed before we read
            Task.Delay(300).ContinueWith(_ => ProcessNewSidecar(e.FullPath));
        };
        Logs.Debug("VideoChain: Output watcher started.");
    }

    /// <summary>Extracts the user ID from an output file path based on server settings.</summary>
    private static string GetUserIdFromPath(string fullPath)
    {
        if (!Program.ServerSettings.Paths.AppendUserNameToOutputPath)
        {
            return "";
        }
        string normalized = fullPath.Replace('\\', '/');
        string normalizedBase = BaseOutputDir.Replace('\\', '/').TrimEnd('/') + "/";
        if (!normalized.StartsWith(normalizedBase)) return null;
        string relative = normalized[normalizedBase.Length..];
        int slash = relative.IndexOf('/');
        return slash >= 0 ? relative[..slash] : relative;
    }

    /// <summary>Processes a newly created .swarm.json sidecar and adds its video to the matching chain if found.</summary>
    private static void ProcessNewSidecar(string sidecarPath)
    {
        try
        {
            JObject sidecar = JObject.Parse(File.ReadAllText(sidecarPath));
            JObject extraData = sidecar["sui_extra_data"] as JObject;
            if (extraData == null) return;
            string chainId = extraData["videochain_id"]?.ToString();
            if (string.IsNullOrEmpty(chainId)) return;
            int segmentIndex = extraData["videochain_segment"]?.Value<int>() ?? 0;

            string basePath = sidecarPath[..^".swarm.json".Length];
            string videoPath = null;
            foreach (string ext in new[] { ".mp4", ".webm", ".mov", ".mpeg" })
            {
                if (File.Exists(basePath + ext)) { videoPath = basePath + ext; break; }
            }
            if (videoPath == null) return;

            string storedPath = StoredPathFromFilePath(videoPath);
            if (storedPath == null) return;

            string userId = GetUserIdFromPath(videoPath);
            if (userId == null) return;

            lock (GetChainLock(chainId))
            {
                JObject chain = LoadChain(userId, chainId);
                if (chain == null) return;

                JArray segments = (JArray)chain["segments"];
                bool alreadyPresent = segments.Any(s => ((JArray)s["candidates"])?.Any(c => c.ToString() == storedPath) == true);
                if (alreadyPresent) return;

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
                ((JArray)segment["candidates"]).Add(storedPath);

                if (string.IsNullOrEmpty(segment["prompt"]?.ToString()))
                {
                    string prompt = sidecar["prompt"]?.ToString();
                    if (!string.IsNullOrEmpty(prompt)) segment["prompt"] = prompt;
                }

                SaveChain(userId, chainId, chain);
                Logs.Debug($"VideoChain: Added candidate to chain {chainId} segment {segmentIndex} via watcher.");
            }
        }
        catch (Exception ex)
        {
            Logs.Debug($"VideoChain: Failed to process sidecar {sidecarPath}: {ex.Message}");
        }
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

        if (relativePath.StartsWith("View/"))
        {
            relativePath = relativePath["View/".Length..];
        }
        else if (relativePath.StartsWith("Output/"))
        {
            relativePath = relativePath["Output/".Length..];
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

    /// <summary>Polls candidate counts for multiple chains in a single request. chainData is a JSON array of {chainId, segmentIndex}.
    /// The watcher keeps chain JSONs current, so this just reads them directly — no directory scan.</summary>
    public async Task<JObject> PollChainProgress(Session session, string chainData)
    {
        JArray polls;
        try { polls = JArray.Parse(chainData); }
        catch { return new JObject() { ["error"] = "Invalid chainData JSON" }; }

        JObject counts = [];
        foreach (JObject poll in polls)
        {
            string chainId = poll["chainId"]?.ToString();
            int segmentIndex = poll["segmentIndex"]?.Value<int>() ?? 0;
            if (string.IsNullOrEmpty(chainId)) continue;

            JObject chain = LoadChain(session.User.UserID, chainId);
            if (chain == null) { counts[chainId] = -1; continue; }

            JArray segments = chain["segments"] as JArray;
            int count = (segments != null && segments.Count > segmentIndex)
                ? ((JArray)segments[segmentIndex]?["candidates"])?.Count ?? 0
                : 0;
            counts[chainId] = count;
        }

        return new JObject() { ["success"] = true, ["counts"] = counts };
    }

    /// <summary>Converts a filesystem path to stored URL format (View/...).</summary>
    private static string StoredPathFromFilePath(string fullPath)
    {
        string normalizedPath = fullPath.Replace('\\', '/');
        string normalizedBase = BaseOutputDir.Replace('\\', '/').TrimEnd('/');
        if (normalizedPath.StartsWith(normalizedBase + "/"))
        {
            return "View/" + normalizedPath[(normalizedBase.Length + 1)..];
        }
        return null;
    }

    /// <summary>Scans the output directory for .swarm.json sidecars belonging to this chain and adds any missing candidates.</summary>
    private static bool SyncChainWithOutputFiles(string userId, string chainId, JObject chain)
    {
        string scanDir = (Program.ServerSettings.Paths.AppendUserNameToOutputPath && !string.IsNullOrEmpty(userId))
            ? Path.Combine(BaseOutputDir, userId)
            : BaseOutputDir;
        if (!Directory.Exists(scanDir))
        {
            return false;
        }

        // Use chain creation date to skip old files (with buffer for clock skew)
        DateTime minFileTime = DateTime.MinValue;
        if (DateTime.TryParse(chain["created"]?.ToString(), null, System.Globalization.DateTimeStyles.RoundtripKind, out DateTime chainCreated))
        {
            minFileTime = chainCreated.AddMinutes(-5).ToUniversalTime();
        }

        JArray segments = (JArray)chain["segments"];

        // Build set of already-known candidates for dedup
        HashSet<string> knownCandidates = [];
        foreach (JObject seg in segments)
        {
            foreach (JToken c in (JArray)seg["candidates"])
            {
                knownCandidates.Add(c.ToString());
            }
        }

        string[] videoExtensions = [".mp4", ".webm", ".mov", ".mpeg"];
        bool modified = false;

        try
        {
            foreach (string sidecarFile in Directory.EnumerateFiles(scanDir, "*.json", SearchOption.AllDirectories).Where(f => f.EndsWith(".swarm.json", StringComparison.OrdinalIgnoreCase)))
            {
                if (minFileTime != DateTime.MinValue && File.GetLastWriteTimeUtc(sidecarFile) < minFileTime)
                {
                    continue;
                }
                try
                {
                    JObject sidecar = JObject.Parse(File.ReadAllText(sidecarFile));
                    JObject extraData = sidecar["sui_extra_data"] as JObject;
                    if (extraData == null) continue;
                    if (extraData["videochain_id"]?.ToString() != chainId) continue;

                    int segmentIndex = extraData["videochain_segment"]?.Value<int>() ?? 0;

                    // Strip ".swarm.json" to get the base path, then find the video file
                    string basePath = sidecarFile[..^".swarm.json".Length];
                    string videoPath = null;
                    foreach (string ext in videoExtensions)
                    {
                        if (File.Exists(basePath + ext))
                        {
                            videoPath = basePath + ext;
                            break;
                        }
                    }
                    if (videoPath == null) continue;

                    string storedPath = StoredPathFromFilePath(videoPath);
                    if (storedPath == null || knownCandidates.Contains(storedPath)) continue;

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
                    ((JArray)segment["candidates"]).Add(storedPath);
                    knownCandidates.Add(storedPath);

                    // Pull prompt from sidecar if not already set
                    if (string.IsNullOrEmpty(segment["prompt"]?.ToString()))
                    {
                        string prompt = sidecar["prompt"]?.ToString();
                        if (!string.IsNullOrEmpty(prompt))
                        {
                            segment["prompt"] = prompt;
                        }
                    }

                    modified = true;
                }
                catch (Exception ex)
                {
                    Logs.Debug($"VideoChain: Failed to read sidecar {sidecarFile}: {ex.Message}");
                }
            }
        }
        catch (Exception ex)
        {
            Logs.Warning($"VideoChain: Failed to scan output directory for chain {chainId}: {ex.Message}");
        }

        return modified;
    }

    /// <summary>Gets a video chain by ID.</summary>
    public async Task<JObject> GetVideoChain(Session session, string chainId)
    {
        JObject chain = LoadChain(session.User.UserID, chainId);
        if (chain == null)
        {
            return new JObject() { ["error"] = "Chain not found" };
        }

        // Fallback scan: if the chain has no candidates at all (e.g., watcher missed events due to
        // a server restart, or chains generated before the watcher was introduced), do a one-time
        // directory scan to recover. The watcher handles ongoing updates in real-time.
        JArray segs = chain["segments"] as JArray;
        bool hasCandidates = segs != null && segs.Any(s => ((JArray)s["candidates"])?.Count > 0);
        if (!hasCandidates)
        {
            lock (GetChainLock(chainId))
            {
                chain = LoadChain(session.User.UserID, chainId);
                if (chain == null) return new JObject() { ["error"] = "Chain not found" };
                if (SyncChainWithOutputFiles(session.User.UserID, chainId, chain))
                {
                    SaveChain(session.User.UserID, chainId, chain);
                }
            }
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

/// <summary>Adds candidates to a chain segment.</summary>
    public async Task<JObject> AddChainCandidates(Session session, string chainId, int segmentIndex, string[] candidates, string initImage = null, string prompt = null)
    {
        // Lock to prevent race conditions when multiple batches finish close together
        lock (GetChainLock(chainId))
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
    }

    /// <summary>Updates a chain segment with selection.</summary>
    public async Task<JObject> UpdateChainSegment(Session session, string chainId, int segmentIndex, string selectedVideo)
    {
        lock (GetChainLock(chainId))
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
    }

    /// <summary>Deletes non-selected candidates from a segment.</summary>
    public async Task<JObject> DeleteChainCandidates(Session session, string chainId, int segmentIndex)
    {
        lock (GetChainLock(chainId))
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

                    // Get prompt: segment["prompt"] is already the parsed prompt (set by the watcher).
                    // Fall back to the .swarm.json sidecar if the segment prompt is missing.
                    string prompt = segment["prompt"]?.ToString() ?? "";
                    if (string.IsNullOrEmpty(prompt))
                    {
                        string videoExt = Path.GetExtension(fullPath);
                        string sidecarPath = fullPath[..^videoExt.Length] + ".swarm.json";
                        if (File.Exists(sidecarPath))
                        {
                            try
                            {
                                JObject sidecar = JObject.Parse(File.ReadAllText(sidecarPath));
                                prompt = sidecar["prompt"]?.ToString() ?? "";
                            }
                            catch { }
                        }
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
            // Store path relative to the user's output base directory, matching GetUserVideoChainDir logic
            string userOutputDir = (Program.ServerSettings.Paths.AppendUserNameToOutputPath && !string.IsNullOrEmpty(session.User.UserID))
                ? Path.Combine(BaseOutputDir, session.User.UserID).Replace("\\", "/")
                : BaseOutputDir.Replace("\\", "/");
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
