/**
 * VideoChain Extension v2
 *
 * Clean rewrite using SwarmUI's native queue system.
 * Injects videochain metadata into generations, then reads it from results.
 */

class VideoChainManager {
    constructor() {
        // Editor state
        this.activeChain = null;
        this.currentSegmentIndex = 0;

        // Track in-flight generations: chainId -> { segmentIndex, expectedCount, receivedCount }
        this.pendingGenerations = new Map();

        // UI elements
        this.setupDialog = null;
        this.editorModal = null;
    }

    /** Initialize the extension */
    init() {
        this.injectMenuOptions();
        this.createSetupDialog();
        this.createEditorModal();
        this.hookResultCapture();
        console.log('VideoChain v2 initialized');
    }

    /** Hook into result capture to intercept chain videos */
    hookResultCapture() {
        let self = this;

        // Hook gotImageResult - this is called for all generation results
        let waitForGotImageResult = setInterval(() => {
            if (typeof gotImageResult === 'undefined') return;
            clearInterval(waitForGotImageResult);

            let originalGotImageResult = gotImageResult;
            window.gotImageResult = function(image, metadata, batchId) {
                // Check if this is a video
                let isVideo = (typeof isVideoExt === 'function')
                    ? isVideoExt(image)
                    : /\.(mp4|webm|mov|mpeg)$/i.test(image);

                // Also check if this is a video's last frame (saved by FrameSaver: video-1.png)
                // If so, derive the video path from it
                let isLastFrame = /-1\.(png|jpg|jpeg)$/i.test(image);

                if (isVideo) {
                    self.handleVideoResult(image, metadata);
                } else if (isLastFrame && self.pendingGenerations.size > 0) {
                    // Derive video path: remove "-1.png" suffix, add ".mp4"
                    let videoPath = image.replace(/-1\.(png|jpg|jpeg)$/i, '.mp4');
                    self.handleVideoResult(videoPath, metadata);
                }

                return originalGotImageResult(image, metadata, batchId);
            };
        }, 500);
    }

    /** Handle a video result - check for chain metadata */
    handleVideoResult(videoPath, metadataStr) {
        let metadata = {};
        try {
            if (typeof metadataStr === 'string') {
                metadata = JSON.parse(metadataStr);
            } else if (typeof metadataStr === 'object') {
                metadata = metadataStr;
            }
        } catch (e) {
            // Ignore parse errors
        }

        // Check for our metadata - it comes back in sui_extra_data
        let extraMeta = metadata.sui_extra_data || metadata.extra_metadata || metadata.sui_extra_metadata || {};
        let chainId = extraMeta.videochain_id;
        let segmentIndex = extraMeta.videochain_segment;

        if (!chainId) {
            // No chain metadata - not a chain video, ignore it
            return;
        }

        // Verify this chain is actually pending (wasn't deleted)
        if (!this.pendingGenerations.has(chainId)) {
            // Chain was deleted or already completed, ignore this result
            return;
        }

        // Normalize the video path
        let normalizedPath = this.normalizeVideoPath(videoPath);

        // Add to the chain
        this.addCandidateToChain(chainId, segmentIndex, normalizedPath, metadata);
    }

    /** Normalize video path for storage */
    normalizeVideoPath(videoPath) {
        let path = videoPath;

        // Handle full URLs
        try {
            let url = new URL(path, window.location.origin);
            path = url.pathname;
        } catch (e) {}

        // Remove leading slash
        if (path.startsWith('/')) {
            path = path.substring(1);
        }

        // Decode URL encoding
        try {
            path = decodeURIComponent(path);
        } catch (e) {}

        return path;
    }

    /** Add a candidate video to a chain segment */
    addCandidateToChain(chainId, segmentIndex, videoPath, metadata) {
        let pending = this.pendingGenerations.get(chainId);
        if (!pending) {
            pending = { segmentIndex: segmentIndex, expectedCount: 1, receivedCount: 0, candidates: [] };
            this.pendingGenerations.set(chainId, pending);
        }

        // Avoid duplicates
        if (pending.candidates.includes(videoPath)) {
            return;
        }

        pending.candidates.push(videoPath);
        pending.receivedCount++;

        // Check if we have all expected candidates
        if (pending.receivedCount >= pending.expectedCount) {
            this.finalizeSegmentGeneration(chainId, pending);
        }
    }

    /** Finalize a segment generation - save candidates to backend */
    finalizeSegmentGeneration(chainId, pending) {

        let prompt = document.getElementById('alt_prompt_textbox')?.value ||
                     document.getElementById('input_prompt')?.value || '';

        genericRequest('AddChainCandidates', {
            chainId: chainId,
            segmentIndex: pending.segmentIndex,
            candidates: pending.candidates,
            prompt: prompt
        }, (data) => {
            // Remove from pending
            this.pendingGenerations.delete(chainId);

            if (data.error) {
                showError(data.error);
                return;
            }

            let chainName = data.chain?.name || 'Chain';
            doNoticePopover(`"${chainName}" segment ${pending.segmentIndex + 1}: ${pending.candidates.length} candidates saved`, 'notice-pop-green');

            // Update active chain if it's the one we just generated for
            if (this.activeChain && this.activeChain.chain_id == chainId) {
                this.activeChain = data.chain;
            }
        });
    }

    /** Inject menu options into the generate popover */
    injectMenuOptions() {
        let checkInterval = setInterval(() => {
            let popover = document.getElementById('popover_generate');
            let popoverCenter = document.getElementById('popover_generate_center');
            if (popover && popoverCenter) {
                clearInterval(checkInterval);
                this.addMenuButton(popover);
                this.addMenuButton(popoverCenter);
            }
        }, 500);
    }

    addMenuButton(popover) {
        if (popover.querySelector('.video-chain-menu-button')) {
            return;
        }

        let chainButton = document.createElement('div');
        chainButton.className = 'sui_popover_model_button translate video-chain-menu-button';
        chainButton.innerText = 'Generate Video Chain';
        chainButton.onclick = () => {
            hidePopover('generate');
            hidePopover('generate_center');
            this.openSetupDialog();
        };
        popover.appendChild(chainButton);

        let manageButton = document.createElement('div');
        manageButton.className = 'sui_popover_model_button translate video-chain-menu-button';
        manageButton.innerText = 'Manage Video Chains';
        manageButton.onclick = () => {
            hidePopover('generate');
            hidePopover('generate_center');
            this.openChainList();
        };
        popover.appendChild(manageButton);
    }

    /** Create the setup dialog */
    createSetupDialog() {
        this.setupDialog = document.createElement('div');
        this.setupDialog.id = 'video_chain_setup_dialog';
        this.setupDialog.className = 'video-chain-modal';
        this.setupDialog.innerHTML = `
            <div class="video-chain-modal-content video-chain-setup">
                <button class="video-chain-close-x" onclick="videoChainManager.closeSetupDialog()">&times;</button>
                <h2>Generate Video Chain</h2>
                <div class="video-chain-form">
                    <div class="video-chain-form-row">
                        <label for="video_chain_name">Chain Name:</label>
                        <input type="text" id="video_chain_name" placeholder="my_video_chain" />
                    </div>
                    <div class="video-chain-form-row video-chain-hint">
                        <span>Candidates per segment uses the current <strong>Images</strong> parameter.</span>
                    </div>
                </div>
                <div class="video-chain-buttons">
                    <button class="basic-button video-chain-start-btn" onclick="videoChainManager.startChain()">Start Chain</button>
                    <button class="basic-button" onclick="videoChainManager.closeSetupDialog()">Cancel</button>
                </div>
            </div>
        `;
        document.body.appendChild(this.setupDialog);
    }

    /** Create the chain editor modal */
    createEditorModal() {
        this.editorModal = document.createElement('div');
        this.editorModal.id = 'video_chain_editor_modal';
        this.editorModal.className = 'video-chain-modal';
        this.editorModal.innerHTML = `
            <div class="video-chain-modal-content video-chain-editor">
                <button class="video-chain-close-x" onclick="videoChainManager.closeEditorModal()">&times;</button>
                <div class="video-chain-editor-header">
                    <h2>Video Chain Editor</h2>
                    <span class="video-chain-info">
                        Chain: <span id="video_chain_editor_name">-</span> |
                        Segment: <span id="video_chain_editor_segment">-</span>
                    </span>
                </div>
                <div class="video-chain-candidates-grid" id="video_chain_candidates_container">
                </div>
                <div class="video-chain-timeline" id="video_chain_timeline">
                    <h3>Timeline</h3>
                    <div class="video-chain-timeline-segments" id="video_chain_timeline_segments">
                    </div>
                </div>
                <div class="video-chain-editor-buttons">
                    <button class="basic-button video-chain-continue-btn" id="video_chain_continue_btn" onclick="videoChainManager.continueChain()">Continue Chain</button>
                    <button class="basic-button video-chain-stitch-btn" onclick="videoChainManager.stitchChain()">Stitch All</button>
                    <button class="basic-button video-chain-cleanup-btn" onclick="videoChainManager.showCleanupPrompt()">Delete Non-Selected</button>
                    <button class="basic-button" onclick="videoChainManager.closeEditorModal()">Close</button>
                </div>
            </div>
        `;
        document.body.appendChild(this.editorModal);
    }

    /** Open the setup dialog */
    openSetupDialog() {
        let now = new Date();
        let defaultName = `chain_${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}${String(now.getSeconds()).padStart(2,'0')}`;
        document.getElementById('video_chain_name').value = defaultName;
        this.setupDialog.style.display = 'flex';
    }

    closeSetupDialog() {
        this.setupDialog.style.display = 'none';
    }

    /** Start a new chain - create on backend then generate first segment */
    startChain() {
        let name = document.getElementById('video_chain_name').value.trim();
        let candidatesPerSegment = parseInt(document.getElementById('input_images')?.value) || 1;

        genericRequest('CreateVideoChain', {
            name: name,
            candidatesPerSegment: candidatesPerSegment
        }, (data) => {
            if (data.error) {
                showError(data.error);
                return;
            }

            this.closeSetupDialog();

            let chain = data.chain;
            this.activeChain = chain;
            this.currentSegmentIndex = 0;

            // Generate with chain metadata
            this.generateForChain(chain.chain_id, 0, candidatesPerSegment);
        });
    }

    /** Generate candidates for a chain segment with metadata injection */
    generateForChain(chainId, segmentIndex, expectedCount) {
        // Ensure Save Last Frame is enabled
        this.ensureSaveLastFrameEnabled();

        // Register pending generation
        this.pendingGenerations.set(chainId, {
            segmentIndex: segmentIndex,
            expectedCount: expectedCount,
            receivedCount: 0,
            candidates: []
        });

        // Use postCollectRun callback to inject our metadata
        mainGenHandler.doGenerate({}, {}, (actualInput) => {
            actualInput.extra_metadata = actualInput.extra_metadata || {};
            actualInput.extra_metadata.videochain_id = chainId;
            actualInput.extra_metadata.videochain_segment = segmentIndex;
        });

        doNoticePopover(`Generating segment ${segmentIndex + 1} for chain...`, 'notice-pop-blue');
    }

    /** Ensure Save Last Frame is enabled for chaining */
    ensureSaveLastFrameEnabled() {
        let saveLastFrameInput = document.getElementById('input_savelastframe');
        if (saveLastFrameInput && !saveLastFrameInput.checked) {
            saveLastFrameInput.checked = true;
            triggerChangeFor(saveLastFrameInput);
        }
    }

    /** Open the chain editor modal */
    openEditorModal() {
        if (!this.activeChain) {
            showError('No active chain');
            return;
        }

        document.getElementById('video_chain_editor_name').textContent = this.activeChain.name;

        let segments = this.activeChain.segments || [];
        let totalSegments = Math.max(segments.length, this.currentSegmentIndex + 1);
        document.getElementById('video_chain_editor_segment').textContent = `${this.currentSegmentIndex + 1}/${totalSegments}`;

        this.renderCandidates();
        this.renderTimeline();

        this.editorModal.style.display = 'flex';
    }

    closeEditorModal(returnToList = true) {
        this.editorModal.style.display = 'none';
        if (returnToList) {
            this.openChainList();
        }
    }

    /** Render candidate videos in the editor */
    renderCandidates() {
        let container = document.getElementById('video_chain_candidates_container');
        container.innerHTML = '';

        let segments = this.activeChain.segments || [];
        let currentSegment = segments[this.currentSegmentIndex];

        if (!currentSegment || !currentSegment.candidates || currentSegment.candidates.length == 0) {
            container.innerHTML = `<p class="video-chain-no-candidates">No candidates for Segment ${this.currentSegmentIndex + 1} yet.</p>`;
            return;
        }

        let header = document.createElement('div');
        header.className = 'video-chain-candidates-header';
        header.innerHTML = `<strong>Selecting for Segment ${this.currentSegmentIndex + 1}</strong>`;
        container.appendChild(header);

        let candidates = currentSegment.candidates;
        let selectedVideo = currentSegment.selected_video;

        candidates.forEach((candidate, index) => {
            let isSelected = candidate == selectedVideo;
            let card = document.createElement('div');
            card.className = `video-chain-candidate-card ${isSelected ? 'selected' : ''}`;
            card.dataset.video = candidate;

            let videoSrc = candidate.startsWith('/') ? candidate : `/${candidate}`;
            let escapedCandidate = candidate.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

            card.innerHTML = `
                <div class="video-chain-candidate-preview">
                    <video loop muted playsinline>
                        <source src="${videoSrc}" type="video/mp4">
                    </video>
                </div>
                <div class="video-chain-candidate-controls">
                    <span class="video-chain-candidate-label">Candidate ${index + 1}</span>
                    <button class="basic-button video-chain-select-btn ${isSelected ? 'selected' : ''}"
                            onclick="videoChainManager.selectCandidate('${escapedCandidate}')">
                        ${isSelected ? 'Selected' : 'Select'}
                    </button>
                </div>
            `;

            let video = card.querySelector('video');
            let preview = card.querySelector('.video-chain-candidate-preview');
            if (video) {
                card.addEventListener('mouseenter', () => video.play());
                card.addEventListener('mouseleave', () => {
                    video.pause();
                    video.currentTime = 0;
                });
                preview.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (typeof imageFullView !== 'undefined') {
                        imageFullView.showImage(videoSrc, currentSegment.metadata || '{}', `chain_${index}`);
                    }
                });
            }

            container.appendChild(card);
        });
    }

    /** Render the timeline showing segments */
    renderTimeline() {
        let container = document.getElementById('video_chain_timeline_segments');
        container.innerHTML = '';

        let segments = this.activeChain.segments || [];
        let maxSegments = Math.max(segments.length, this.currentSegmentIndex + 1);

        for (let index = 0; index < maxSegments; index++) {
            let segment = segments[index];
            let hasSelection = segment && !!segment.selected_video;
            let hasCandidates = segment && segment.candidates && segment.candidates.length > 0;
            let isCurrent = index == this.currentSegmentIndex;

            let segmentEl = document.createElement('div');
            segmentEl.className = `video-chain-timeline-segment ${hasSelection ? 'has-selection' : ''} ${isCurrent ? 'current' : ''} ${hasCandidates ? 'has-candidates' : ''}`;
            segmentEl.innerHTML = `
                <span class="video-chain-timeline-segment-number">${index + 1}</span>
                ${hasSelection ? '<span class="video-chain-timeline-check">&#10003;</span>' : ''}
            `;
            segmentEl.onclick = () => {
                if (hasCandidates) {
                    this.currentSegmentIndex = index;
                    this.renderCandidates();
                    this.renderTimeline();
                    document.getElementById('video_chain_editor_segment').textContent =
                        `${this.currentSegmentIndex + 1}/${maxSegments}`;
                }
            };

            container.appendChild(segmentEl);

            if (index < maxSegments - 1) {
                let arrow = document.createElement('span');
                arrow.className = 'video-chain-timeline-arrow';
                arrow.innerHTML = '&rarr;';
                container.appendChild(arrow);
            }
        }
    }

    /** Select a candidate video */
    selectCandidate(videoPath) {
        genericRequest('UpdateChainSegment', {
            chainId: this.activeChain.chain_id,
            segmentIndex: this.currentSegmentIndex,
            selectedVideo: videoPath
        }, (data) => {
            if (data.error) {
                showError(data.error);
                return;
            }
            this.activeChain = data.chain;
            this.renderCandidates();
            this.renderTimeline();
            doNoticePopover(`Video selected for Segment ${this.currentSegmentIndex + 1}!`, 'notice-pop-green');
        });
    }

    /** Continue the chain - set last frame as init image and prompt for next segment */
    continueChain() {
        let segments = this.activeChain.segments || [];
        let currentSegment = segments[this.currentSegmentIndex];

        if (!currentSegment || !currentSegment.selected_video) {
            showError('Please select a video for the current segment first');
            return;
        }

        // Get last frame path (FrameSaver format: video-1.png)
        let videoPath = currentSegment.selected_video;
        let lastFramePath = this.getLastFramePath(videoPath);

        // Set as init image
        this.setInitImageFromPath(lastFramePath, () => {
            this.closeEditorModal(false);

            let nextSegment = this.currentSegmentIndex + 1;
            let candidatesPerSegment = parseInt(document.getElementById('input_images')?.value) || 1;

            doNoticePopover(`Ready for segment ${nextSegment + 1}. Adjust parameters then Generate.`, 'notice-pop-blue');

            // Store which chain/segment we're continuing for
            this.continuingChainId = this.activeChain.chain_id;
            this.continuingSegmentIndex = nextSegment;
            this.continuingExpectedCount = candidatesPerSegment;

            // Show a banner so user knows they're in chain mode
            this.showContinueBanner(nextSegment + 1);
        });
    }

    /** Show a banner indicating chain continuation mode */
    showContinueBanner(segmentNum) {
        this.hideContinueBanner();

        let chainName = this.activeChain?.name || 'Chain';
        let insertPoint = this.findGenerateButtonInsertPoint();

        let banner = document.createElement('div');
        banner.id = 'video_chain_continue_banner';
        banner.className = 'video-chain-pending-inline';
        banner.innerHTML = `
            <div class="video-chain-pending-header">
                <strong>${chainName}</strong> - Ready for Segment ${segmentNum}
            </div>
            <div class="video-chain-pending-buttons">
                <button class="basic-button video-chain-generate-next-btn" onclick="videoChainManager.generateNextSegment()">
                    Generate Segment ${segmentNum}
                </button>
                <button class="basic-button" onclick="videoChainManager.openEditorModal()">
                    Editor
                </button>
                <button class="basic-button" onclick="videoChainManager.cancelContinue()">
                    Cancel
                </button>
            </div>
        `;

        if (insertPoint) {
            insertPoint.parentNode.insertBefore(banner, insertPoint.nextSibling);
        } else {
            banner.className = 'video-chain-pending-fixed';
            document.body.appendChild(banner);
        }
    }

    hideContinueBanner() {
        let banner = document.getElementById('video_chain_continue_banner');
        if (banner) banner.remove();
    }

    /** Generate the next segment (called from continue banner) */
    generateNextSegment() {
        this.hideContinueBanner();

        if (!this.continuingChainId) {
            showError('No chain to continue');
            return;
        }

        this.generateForChain(this.continuingChainId, this.continuingSegmentIndex, this.continuingExpectedCount);

        // Clear continuation state
        this.continuingChainId = null;
        this.continuingSegmentIndex = null;
        this.continuingExpectedCount = null;
    }

    cancelContinue() {
        this.hideContinueBanner();
        this.continuingChainId = null;
        this.continuingSegmentIndex = null;
        this.continuingExpectedCount = null;
        this.openEditorModal();
    }

    /** Get last frame image path from video path */
    getLastFramePath(videoPath) {
        let lastDot = videoPath.lastIndexOf('.');
        if (lastDot > 0) {
            return videoPath.substring(0, lastDot) + '-1.png';
        }
        return videoPath + '-1.png';
    }

    /** Find generate button insert point */
    findGenerateButtonInsertPoint() {
        let element = document.getElementById('generate_button_row') ||
                      document.getElementById('alt_generate_button') ||
                      document.querySelector('#t2i_generate_area .generate-button') ||
                      document.getElementById('generate_button') ||
                      document.getElementById('input_generate') ||
                      document.querySelector('.generate-button:not(#simple_generate_button)');

        if (element) {
            return element.closest('.sui-group-controls') || element.closest('.generate-button-wrapper') || element.parentNode || element;
        }
        return null;
    }

    /** Set init image from a file path */
    setInitImageFromPath(imagePath, callback) {
        let imageUrl = imagePath.startsWith('/') ? imagePath : `/${imagePath}`;

        fetch(imageUrl)
            .then(response => {
                if (!response.ok) throw new Error(`Last frame not found: ${imagePath}`);
                return response.blob();
            })
            .then(blob => {
                let initImageParam = document.getElementById('input_initimage');
                if (initImageParam) {
                    let file = new File([blob], 'last_frame.png', { type: 'image/png' });
                    let container = new DataTransfer();
                    container.items.add(file);
                    initImageParam.files = container.files;
                    triggerChangeFor(initImageParam);
                    toggleGroupOpen(initImageParam, true);

                    let toggler = document.getElementById('input_group_content_initimage_toggle');
                    if (toggler) {
                        toggler.checked = true;
                        triggerChangeFor(toggler);
                    }
                }
                if (callback) callback();
            })
            .catch(err => {
                console.error('VideoChain: Failed to load last frame:', err);
                showError('Could not load last frame. Make sure "Save Last Frame" is enabled.');
                if (callback) callback();
            });
    }

    /** Show cleanup prompt */
    showCleanupPrompt() {
        let segments = this.activeChain.segments || [];
        let currentSegment = segments[this.currentSegmentIndex];

        if (!currentSegment || !currentSegment.selected_video) {
            showError('Please select a video first');
            return;
        }

        let nonSelectedCount = (currentSegment.candidates?.length || 0) - 1;
        if (nonSelectedCount <= 0) {
            doNoticePopover('No non-selected candidates to delete.', 'notice-pop-yellow');
            return;
        }

        if (confirm(`Delete ${nonSelectedCount} non-selected candidate(s)? This cannot be undone.`)) {
            this.deleteOtherCandidates();
        }
    }

    deleteOtherCandidates() {
        genericRequest('DeleteChainCandidates', {
            chainId: this.activeChain.chain_id,
            segmentIndex: this.currentSegmentIndex
        }, (data) => {
            if (data.error) {
                showError(data.error);
                return;
            }
            this.activeChain = data.chain;
            this.renderCandidates();
            doNoticePopover(`Deleted ${data.deleted?.length || 0} candidates`, 'notice-pop-green');
        });
    }

    /** Stitch chain */
    stitchChain() {
        let segments = this.activeChain.segments || [];
        let selectedCount = segments.filter(s => s.selected_video).length;

        if (selectedCount == 0) {
            showError('No segments selected. Please select at least one video.');
            return;
        }

        doNoticePopover(`Stitching "${this.activeChain.name}"...`, 'notice-pop-blue');
        this.closeEditorModal(false);

        genericRequest('StitchChain', {
            chainId: this.activeChain.chain_id
        }, (data) => {
            if (data.error) {
                showError(`Stitch failed: ${data.error}`);
                return;
            }

            doNoticePopover(`"${this.activeChain.name}" stitched!`, 'notice-pop-green');

            if (data.output) {
                let videoSrc = `${getImageOutPrefix()}/${data.output}`;
                setCurrentImage(videoSrc, '{}', 'chain_final');
            }
        });
    }

    /** Load a chain by ID */
    loadChain(chainId) {
        genericRequest('GetVideoChain', {
            chainId: chainId
        }, (data) => {
            if (data.error) {
                showError(data.error);
                return;
            }
            this.activeChain = data.chain;
            this.currentSegmentIndex = Math.max(0, (this.activeChain.segments?.length || 1) - 1);
            this.openEditorModal();
        });
    }

    /** Open chain list dialog */
    openChainList() {
        genericRequest('ListVideoChains', {}, (data) => {
            if (data.error) {
                showError(data.error);
                return;
            }

            let chains = data.chains || [];
            let existingDialog = document.getElementById('video_chain_list_dialog');
            if (existingDialog) existingDialog.remove();

            let gridHtml = chains.length == 0
                ? '<p class="video-chain-no-chains">No video chains found.</p>'
                : chains.map(chain => {
                    let thumbnailHtml = '<div class="video-chain-grid-thumb-placeholder">No Preview</div>';
                    if (chain.first_video) {
                        let framePath = this.getLastFramePath(chain.first_video);
                        let frameUrl = framePath.startsWith('/') ? framePath : `/${framePath}`;
                        thumbnailHtml = `<img class="video-chain-grid-thumb" src="${frameUrl}" onerror="this.parentElement.innerHTML='<div class=\\'video-chain-grid-thumb-placeholder\\'>No Preview</div>'" />`;
                    }

                    let createdDateTime = '';
                    if (chain.created) {
                        let date = new Date(chain.created);
                        createdDateTime = date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
                    }

                    // Determine status display
                    let displayStatus = '';
                    let statusClass = '';
                    let isGenerating = this.pendingGenerations.has(chain.chain_id);

                    if (chain.status == 'stitched' || chain.status == 'completed') {
                        displayStatus = 'Stitched';
                        statusClass = 'status-stitched';
                    } else if (isGenerating) {
                        displayStatus = 'Generating...';
                        statusClass = 'status-generating';
                    } else if (chain.status == 'in_progress' || !chain.status) {
                        if (chain.last_segment_has_selection) {
                            displayStatus = 'Ready to Continue';
                            statusClass = 'status-ready';
                        } else if (chain.segment_count > 0) {
                            displayStatus = 'Waiting for Selection';
                            statusClass = 'status-waiting';
                        } else {
                            displayStatus = 'New';
                            statusClass = 'status-new';
                        }
                    }

                    return `
                        <div class="video-chain-grid-item" onclick="videoChainManager.loadChain('${chain.chain_id}'); document.getElementById('video_chain_list_dialog').remove();">
                            <div class="video-chain-grid-thumb-container">
                                ${thumbnailHtml}
                            </div>
                            <div class="video-chain-grid-item-info">
                                <strong class="video-chain-grid-name">${chain.name}</strong>
                                <span class="video-chain-grid-meta">${chain.segment_count} segment${chain.segment_count != 1 ? 's' : ''}</span>
                                <span class="video-chain-grid-status ${statusClass}">${displayStatus}</span>
                                <span class="video-chain-grid-date">${createdDateTime}</span>
                            </div>
                            <button class="basic-button video-chain-grid-delete-btn" onclick="event.stopPropagation(); videoChainManager.deleteChainPrompt('${chain.chain_id}');">×</button>
                        </div>
                    `;
                }).join('');

            let listDialog = document.createElement('div');
            listDialog.className = 'video-chain-modal';
            listDialog.id = 'video_chain_list_dialog';
            listDialog.innerHTML = `
                <div class="video-chain-modal-content video-chain-list-modal">
                    <button class="video-chain-close-x" onclick="document.getElementById('video_chain_list_dialog').remove()">&times;</button>
                    <h2>Your Video Chains</h2>
                    <div class="video-chain-grid">${gridHtml}</div>
                    <div class="video-chain-buttons">
                        <button class="basic-button" onclick="document.getElementById('video_chain_list_dialog').remove()">Close</button>
                    </div>
                </div>
            `;
            listDialog.style.display = 'flex';
            document.body.appendChild(listDialog);
        });
    }

    deleteChainPrompt(chainId) {
        if (confirm('Delete this chain? You can choose to keep or delete the video files.')) {
            let deleteVideos = confirm('Also delete the video files?');
            this.deleteChain(chainId, deleteVideos);
        }
    }

    deleteChain(chainId, deleteVideos) {
        // Remove from pending generations immediately to prevent result misrouting
        this.pendingGenerations.delete(chainId);

        genericRequest('DeleteChain', {
            chainId: chainId,
            deleteVideos: deleteVideos
        }, (data) => {
            if (data.error) {
                showError(data.error);
                return;
            }
            doNoticePopover('Chain deleted', 'notice-pop-green');

            let listDialog = document.getElementById('video_chain_list_dialog');
            if (listDialog) {
                listDialog.remove();
                this.openChainList();
            }

            if (this.activeChain && this.activeChain.chain_id == chainId) {
                this.activeChain = null;
                this.closeEditorModal();
            }
        });
    }
}

// Global instance
let videoChainManager = new VideoChainManager();

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    videoChainManager.init();
});

if (document.readyState == 'complete' || document.readyState == 'interactive') {
    setTimeout(() => videoChainManager.init(), 100);
}
