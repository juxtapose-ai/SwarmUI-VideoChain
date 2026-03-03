# VideoChain Extension for SwarmUI

A SwarmUI extension for iterative video generation workflows. Generate multiple candidate videos per segment, compare them side-by-side, select the best, and chain them together into a final video.

## Features

- **Multi-Candidate Generation**: Generate multiple video candidates per segment using your current Images parameter
- **Side-by-Side Comparison**: Visual grid layout for comparing candidate videos (hover to play)
- **Selection & Chaining**: Select the best candidate and use its last frame as init image for the next segment
- **Timeline View**: Visual timeline showing all segments and their selection status
- **FFmpeg Stitching**: One-click concatenation of all selected segments into a final video
- **Cleanup Tools**: Delete non-selected candidates to save disk space

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

All parameters, including the number of candidates generated per segment are controlled by the parameters in the main UI.

### Working with the Chain Editor

After generating candidates, the Chain Editor opens:

- **Candidate Grid**: Shows all generated videos for the current segment
  - Hover over videos to preview them
  - Click to view fullscreen
  - Click **"Select"** to choose the best candidate

- **Timeline**: Shows all segments in your chain
  - Green checkmarks indicate segments with selections
  - Click a segment to view/edit its candidates

- **Actions**:
  - **Continue Chain**: Sets last frame as init image, ready for next segment
  - **Stitch All**: Combine all selected segments into one video
  - **Delete Non-Selected**: Remove non-selected candidates from current segment

### Managing Chains

Access **"Manage Video Chains"** from the Generate dropdown to see all your chains.

Status indicators:
- **Stitched** (green): Chain has been stitched into final video
- **Generating...** (blue, pulsing): Currently generating candidates
- **Ready to Continue** (green): Last segment has a selection, ready to continue
- **Waiting for Selection** (orange): Has candidates but none selected
- **New** (gray): No segments yet

### Chain Storage

Chain data is stored per-user at `Output/{userId}/VideoChains/` (or `Output/VideoChains/` if user paths are disabled) as JSON files containing:
- Chain metadata (name, creation date, status)
- Segment information (candidates, selection, prompt)
- Final output path (after stitching)

## Requirements

- **SwarmUI**: This extension requires SwarmUI
- **Video Model**: Any video generation model (Wan, LTX, etc.)
- **FFmpeg**: Required for video stitching. SwarmUI will detect FFmpeg if:
  - It's installed globally and in your PATH
  - It's included with the ComfyUI backend
- **Save Last Frame**: Enable "Save Last Frame" in video settings for chaining to work

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `CreateVideoChain` | Create a new video chain |
| `GetVideoChain` | Get chain data by ID |
| `ListVideoChains` | List all chains for current user |
| `AddChainCandidates` | Add candidates to a segment |
| `UpdateChainSegment` | Select a candidate for a segment |
| `DeleteChainCandidates` | Remove non-selected candidates |
| `StitchChain` | Concatenate all selected segments |
| `DeleteChain` | Delete a chain and optionally its videos |

## Permissions

Two permission groups control access:

- **videochain_generate**: Create and generate video chains
- **videochain_manage**: Edit, delete, and stitch video chains

Both are enabled by default for all users.

## Tips

1. **Enable Save Last Frame**: The extension automatically enables this when generating, but verify it's on in your video settings.

2. **Batch Size**: More candidates = more options but longer generation. Start with 3-5.

3. **Disk Space**: Use "Delete Non-Selected" regularly to clean up unused candidates.

4. **Multiple Chains**: You can queue multiple chains simultaneously - each captures all parameters at queue time.

## Troubleshooting

### "FFmpeg not available" error
Install FFmpeg and ensure it's in your system PATH, or use a ComfyUI backend that includes FFmpeg.

### Videos don't appear in chain
Make sure "Save Last Frame" is enabled. The extension detects videos by their last-frame image files.

### Chain data is lost
Chain JSON files are stored in `Output/{userId}/VideoChains/`. Back up this directory to preserve chain data.

## License

MIT License
