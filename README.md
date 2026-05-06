# VideoChain Extension for SwarmUI

A SwarmUI extension for easily creating chains of videos to make longer outputs. Generate multiple candidate videos per segment, compare them side-by-side, select the best, and chain them together into a final video.

## Features

- **Multi-Candidate Generation**: Generate multiple video candidates per segment using your current Images parameter
- **Side-by-Side Comparison**: Visual grid layout for comparing candidate videos (hover to play)
- **Selection & Chaining**: Select the best candidate and use its last frame as init image for the next segment
- **Timeline View**: Visual timeline showing all segments and their selection status
- **FFmpeg Stitching**: One-click concatenation of all selected segments into a final video; full stitch history kept per chain
- **Keyframe Library**: Save any video's last frame (or upload an image) as a named keyframe per chain; use keyframes as end frame targets when continuing a segment
- **Add to Chain**: Right-click any video in SwarmUI's history to add it as a candidate to an existing chain segment or as a new end segment
- **Cleanup Tools**: Delete non-selected candidates to save disk space
- **Chain Filtering**: Filter the chain list by status (waiting, ready to continue, stitched, etc.)

## Installation

1. Copy the `VideoChain` folder to `src/Extensions/` in your SwarmUI installation
2. Rebuild SwarmUI:
   - Create an empty file at `src/bin/must_rebuild`
   - Run `launch-windows.bat` (or your platform's launch script)
3. The extension will load automatically on startup

## Usage

### Starting a Video Chain

1. Click the **Generate** button dropdown (or right-click Generate)
2. Select **"Generate Video Chain"**
3. Enter a name for your chain (or use the auto-generated timestamp name)
4. Click **"Start Chain"**

All parameters, including the number of candidates generated per segment, are controlled by the parameters in the main UI.

### Working with the Chain Editor

After generating candidates, the Chain Editor opens:

- **Candidate Grid**: Shows all generated videos for the current segment
  - Hover over videos to preview them
  - Click to view fullscreen
  - Click **"Select"** to choose the best candidate
  - When a segment was generated with an end frame target, the init image and target keyframe are shown above the grid

- **Keyframe Sidebar** (right side): Per-chain reference frames used as end frame targets
  - Click **"+ Upload"** to add any image as a keyframe
  - Hover a keyframe card and click **×** to remove it (does not delete the source file)

- **Timeline**: Shows all segments in your chain
  - Green checkmarks indicate segments with selections
  - Click a segment to view/edit its candidates

- **Actions**:
  - **Continue Chain**: Sets last frame as init image; if keyframes exist, prompts to optionally set an end frame target
  - **Stitch All**: Combine all selected segments into one video
  - **Stitched Videos**: View all past stitches for this chain
  - **Delete Non-Selected**: Remove non-selected candidates from current segment

### Keyframes

Each chain has a **keyframe library** — a collection of reference images used to constrain where a segment should land visually. This enables two important workflows:

**Quality bypass (the "spin" problem)**: Instead of drifting through multiple generations, you can pre-generate the target end state and constrain each segment to land precisely on it — eliminating accumulated drift.

**Multi-endpoint navigation (the "dressing room" problem)**: Generate clean transition target frames independently, then build segments that navigate between those exact frames.

To add a keyframe:
- **From video history**: Right-click any video → **"Save as Keyframe"** → pick the chain (or saves directly if the editor is open)
- **From image history**: Right-click any image → **"Save as Keyframe"**
- **Upload**: Click **"+ Upload"** in the keyframe sidebar of the chain editor

When you click **Continue Chain** and the chain has keyframes, a picker appears asking whether to set an end frame target for the next segment. Selecting a keyframe loads it into the SwarmUI "Video End Image" parameter. Click **Skip** to continue without an end frame target.

### Adding Existing Videos to a Chain

You can add any video from SwarmUI's history to a chain without regenerating it:

1. Right-click a video in SwarmUI's image/video history
2. Select **"Add to Chain"**
3. Pick the chain from the list
4. Navigate to the segment you want, then choose:
   - **Add to Current Segment**: Adds the video as a candidate for the selected segment
   - **Add as New End Segment**: Appends it as a new segment at the end of the chain

### Continuing a Chain

When you click **Continue Chain**:

1. The last frame of the selected video is set as the init image
2. If the chain has keyframes, a picker appears — select an end frame target or skip
3. A banner appears at the top of the UI showing which segment you are ready to generate

From the banner:
- Adjust any parameters you like before generating
- Pressing **Generate** while a continuation is pending shows a confirmation: OK continues the chain, Cancel does a normal single generation
- Pressing the **Interrupt** button while a chain is generating asks for confirmation before aborting

### Managing Chains

Access **"Manage Video Chains"** from the Generate dropdown to see all your chains.

Status indicators:
- **Stitched** (green): Chain has been stitched into a final video
- **Generating...** (blue, pulsing): Currently generating candidates
- **Ready to Continue** (green): Last segment has a selection, ready to continue
- **Waiting for Selection** (orange): Has candidates but none selected
- **New** (gray): No segments yet

Use the **filter bar** at the top of the chain list to show only chains in a particular state.

### Chain Storage

Chain data is stored per-user at `Output/{userId}/VideoChains/` (or `Output/VideoChains/` if user paths are disabled) as JSON files containing:
- Chain metadata (name, creation date, status)
- Segment information (candidates, selection, prompt, end frame keyframe ID)
- Keyframe library (image paths)
- Stitched output history

Uploaded keyframe images are stored at `Output/{userId}/VideoChains/{chainId}/keyframes/`.

## Requirements

- **SwarmUI**: This extension requires SwarmUI
- **Video Model**: Any video generation model (Wan, LTX, etc.)
- **FFmpeg**: Required for video stitching and last frame extraction. SwarmUI will detect FFmpeg if:
  - It's installed globally and in your PATH
  - It's included with the ComfyUI backend
- **Save Last Frame**: Enable "Save Last Frame" in video settings for chaining to work. If a last frame is missing (e.g. some models don't support FrameSaver), the extension will automatically extract it using FFmpeg.

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `CreateVideoChain` | Create a new video chain |
| `GetVideoChain` | Get chain data by ID |
| `ListVideoChains` | List all chains for current user |
| `PollChainProgress` | Poll candidate counts for multiple chains in one request |
| `AddChainCandidates` | Add candidates to a segment |
| `UpdateChainSegment` | Select a candidate for a segment |
| `DeleteChainCandidates` | Remove non-selected candidates |
| `StitchChain` | Concatenate all selected segments |
| `DeleteChain` | Delete a chain and optionally its videos |
| `AddKeyframe` | Add a keyframe to a chain's library (by path or uploaded image) |
| `RemoveKeyframe` | Remove a keyframe from a chain's library |
| `EnsureLastFrame` | Get or extract the last frame of a video (FFmpeg fallback) |

## Permissions

Two permission groups control access:

- **videochain_generate**: Create and generate video chains
- **videochain_manage**: Edit, delete, and stitch video chains

Both are enabled by default for all users.

## Tips

1. **Enable Save Last Frame**: The extension automatically enables this when generating. If your model doesn't support FrameSaver, the extension falls back to FFmpeg extraction automatically.

2. **Batch Size**: More candidates = more options but longer generation. Start with 3-5.

3. **Disk Space**: Use "Delete Non-Selected" regularly to clean up unused candidates.

4. **Add Existing Videos**: Use "Add to Chain" from the video history to incorporate previously generated clips without regenerating.

5. **Multiple Chains**: You can run multiple chains simultaneously — each captures all parameters at queue time.

6. **End Frame Targets**: Use keyframes to reduce drift across long chains. Generate your target frame independently, save it as a keyframe, then set it as the end frame target when continuing each segment.

## Troubleshooting

### "FFmpeg not available" error
Install FFmpeg and ensure it's in your system PATH, or use a ComfyUI backend that includes FFmpeg.

### Videos don't appear in chain
Make sure "Save Last Frame" is enabled. If using a model that doesn't support FrameSaver (e.g. LTX 2.3), the extension will use FFmpeg to extract last frames automatically — this requires FFmpeg to be available.

### Chain data is lost
Chain JSON files are stored in `Output/{userId}/VideoChains/`. Back up this directory to preserve chain data.

## Changelog

### v0.3.0
- Keyframe library: save any video's last frame or upload an image as a per-chain reference keyframe
- End frame targeting: optionally constrain a segment to land on a chosen keyframe when continuing
- EnsureLastFrame: automatic FFmpeg fallback for models that don't support FrameSaver (e.g. LTX 2.3)
- Chain list filter bar: filter by status (generating, waiting for selection, ready to continue, stitched)

### v0.2.0
- Add to Chain: right-click any video in history to add it as a candidate or new end segment
- Stitched outputs history: each stitch is timestamped and kept; view all past stitches per chain
- Interrupt confirmation when a chain is generating
- Generate button confirmation when a chain continuation is pending

### v0.1.0
- Initial release: multi-candidate generation, side-by-side comparison, segment selection, timeline view, FFmpeg stitching

## License

MIT License
