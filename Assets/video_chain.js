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

        // Track in-flight generation polls: chainId -> { segmentIndex, expectedCount, chainName, lastCount, stalePolls }
        this.activePolls = new Map();
        this.managerInterval = null;

        // Keyframe-save pending state
        this.pendingSaveKeyframeVideoSrc = null;

        // End frame staged for the next generation
        this.pendingEndFramePath = null;
        this.pendingEndFrameKeyframeId = null;

        // UI elements
        this.setupDialog = null;
        this.editorModal = null;
    }

    /** Initialize the extension */
    init() {
        if (this._initialized) return;
        this._initialized = true;
        this.injectMenuOptions();
        this.createSetupDialog();
        this.createEditorModal();
        this.createStitchedVideosModal();
        this._patchGenerationButtons();
        this._patchButtonsForImage();
    }

    /** Inject "Add to Chain" into SwarmUI's per-image button menus for video files */
    _patchButtonsForImage() {
        if (typeof buttonsForImage === 'undefined') {
            setTimeout(() => this._patchButtonsForImage(), 500);
            return;
        }
        let origFn = window.buttonsForImage;
        window.buttonsForImage = (fullsrc, src, metadata) => {
            let buttons = origFn(fullsrc, src, metadata);
            if (!src.startsWith('data:')) {
                let candidatePath = src.startsWith('/') ? src.slice(1) : src;
                if (isVideoExt(fullsrc) || isVideoExt(src)) {
                    buttons.push({
                        label: 'Add to Chain',
                        title: 'Add this video as a candidate to a video chain segment.',
                        onclick: () => {
                            this.startAddToChain(candidatePath);
                        }
                    });
                    buttons.push({
                        label: 'Save as Keyframe',
                        title: 'Save this video\'s last frame as a keyframe in a chain.',
                        onclick: () => {
                            this.startSaveAsKeyframe(candidatePath);
                        }
                    });
                } else {
                    buttons.push({
                        label: 'Save as Keyframe',
                        title: 'Save this image as a keyframe in a chain.',
                        onclick: () => {
                            this.startSaveImageAsKeyframe(candidatePath);
                        }
                    });
                }
            }
            return buttons;
        };
    }

    /** Intercept generate/interrupt buttons when chain state is active */
    _patchGenerationButtons() {
        document.body.addEventListener('click', (e) => {
            // Interrupt button: confirm if a chain is currently generating
            if (e.target.closest('#alt_interrupt_button, #interrupt_button')) {
                if (this.activePolls.size == 0) return;
                e.stopPropagation();
                e.preventDefault();
                let count = this.activePolls.size;
                if (confirm(`${count} chain generation${count > 1 ? 's are' : ' is'} in progress.\n\nOK = abort generation\nCancel = continue generating`)) {
                    mainGenHandler.doInterrupt();
                }
                return;
            }
            // Generate button: ask what to do when a chain continuation is pending
            if (e.target.closest('#alt_generate_button, #generate_button')) {
                if (!this.continuingChainId) return;
                e.stopPropagation();
                e.preventDefault();
                let segmentNum = (this.continuingSegmentIndex || 0) + 1;
                let chainName = this.activeChain?.name || 'chain';
                if (confirm(`Ready to continue "${chainName}" (segment ${segmentNum}).\n\nOK = Generate chain segment\nCancel = Regular generate`)) {
                    this.generateNextSegment();
                } else {
                    mainGenHandler.doGenerate();
                }
            }
        }, true);
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
                <div class="video-chain-add-banner" id="video_chain_add_banner" style="display:none">
                    <div class="video-chain-add-banner-inner">
                        <video class="video-chain-add-thumb" id="video_chain_add_thumb" loop muted playsinline autoplay></video>
                        <span class="video-chain-add-text">Adding video &mdash; pick a segment below, then use the action buttons</span>
                    </div>
                    <button class="basic-button video-chain-add-cancel-btn" onclick="videoChainManager.cancelAddToChain()">&times; Cancel</button>
                </div>
                <div class="video-chain-main-area">
                    <div class="video-chain-candidates-wrapper">
                        <div class="video-chain-candidates-grid" id="video_chain_candidates_container">
                        </div>
                    </div>
                    <div class="video-chain-keyframes" id="video_chain_keyframes">
                        <div class="video-chain-keyframes-header">
                            <h3>Keyframes</h3>
                            <button class="basic-button video-chain-keyframe-upload-btn" onclick="videoChainManager.uploadKeyframe()">+ Upload</button>
                        </div>
                        <div class="video-chain-keyframes-strip" id="video_chain_keyframes_strip"></div>
                    </div>
                </div>
                <div class="video-chain-timeline" id="video_chain_timeline">
                    <h3>Timeline</h3>
                    <div class="video-chain-timeline-segments" id="video_chain_timeline_segments">
                    </div>
                </div>
                <div class="video-chain-editor-buttons">
                    <button class="basic-button video-chain-continue-btn" id="video_chain_continue_btn" onclick="videoChainManager.continueChain()">Continue Chain</button>
                    <button class="basic-button video-chain-stitch-btn" id="video_chain_stitch_btn" onclick="videoChainManager.stitchChain()">Stitch All</button>
                    <button class="basic-button video-chain-cleanup-btn" id="video_chain_cleanup_btn" onclick="videoChainManager.showCleanupPrompt()">Delete Non-Selected</button>
                    <button class="basic-button video-chain-stitched-btn" id="video_chain_stitched_btn" onclick="videoChainManager.openStitchedVideos()" style="display:none">Stitched Videos</button>
                    <button class="basic-button video-chain-add-segment-btn" id="video_chain_add_segment_btn" onclick="videoChainManager.addVideoToCurrentSegment()" style="display:none">Add to This Segment</button>
                    <button class="basic-button video-chain-add-end-btn" id="video_chain_add_end_btn" onclick="videoChainManager.addVideoToNewEndSegment()" style="display:none">Add as New End Segment</button>
                    <button class="basic-button" onclick="videoChainManager.closeEditorModal()">Close</button>
                </div>
            </div>
        `;
        document.body.appendChild(this.editorModal);
    }

    /** Create the stitched videos modal */
    createStitchedVideosModal() {
        this.stitchedModal = document.createElement('div');
        this.stitchedModal.id = 'video_chain_stitched_modal';
        this.stitchedModal.className = 'video-chain-modal';
        this.stitchedModal.innerHTML = `
            <div class="video-chain-modal-content video-chain-stitched-content">
                <button class="video-chain-close-x" onclick="videoChainManager.closeStitchedModal()">&times;</button>
                <div class="video-chain-editor-header">
                    <h2>Stitched Videos</h2>
                    <span class="video-chain-info">Chain: <span id="video_chain_stitched_chain_name">-</span></span>
                </div>
                <div class="video-chain-stitched-grid" id="video_chain_stitched_grid"></div>
                <div class="video-chain-buttons">
                    <button class="basic-button" onclick="videoChainManager.closeStitchedModal()">Back to Editor</button>
                </div>
            </div>
        `;
        document.body.appendChild(this.stitchedModal);
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
            this.generateForChain(chain.chain_id, 0, candidatesPerSegment, chain.name);
        });
    }

    /** Generate candidates for a chain segment with metadata injection */
    generateForChain(chainId, segmentIndex, expectedCount, chainName, endFrameKeyframeId = null, endFramePath = null) {
        this.ensureSaveLastFrameEnabled();

        mainGenHandler.doGenerate({}, {}, (actualInput) => {
            actualInput.extra_metadata = actualInput.extra_metadata || {};
            actualInput.extra_metadata.videochain_id = chainId;
            actualInput.extra_metadata.videochain_segment = segmentIndex;
            if (endFrameKeyframeId) {
                actualInput.extra_metadata.videochain_end_frame_keyframe_id = endFrameKeyframeId;
                actualInput.extra_metadata.videochain_end_frame_path = endFramePath;
            }
        });

        this.startChainPolling(chainId, segmentIndex, expectedCount, chainName || chainId);
        doNoticePopover(`Generating segment ${segmentIndex + 1} for chain...`, 'notice-pop-blue');
    }

    /** Begin tracking a chain segment for polling. Starts the shared manager interval if not already running. */
    startChainPolling(chainId, segmentIndex, expectedCount, chainName) {
        this.activePolls.set(chainId, {
            segmentIndex: segmentIndex,
            expectedCount: expectedCount,
            chainName: chainName,
            lastCount: 0,
            stalePolls: 0
        });
        if (!this.managerInterval) {
            this.managerInterval = setInterval(() => this._pollTick(), 3000);
        }
    }

    /** Stop tracking a chain. Stops the shared interval when no chains remain. */
    stopChainPolling(chainId) {
        this.activePolls.delete(chainId);
        if (this.activePolls.size == 0 && this.managerInterval) {
            clearInterval(this.managerInterval);
            this.managerInterval = null;
        }
    }

    /** Single shared poll tick — one request for all active chains. */
    _pollTick() {
        if (this.activePolls.size == 0) {
            clearInterval(this.managerInterval);
            this.managerInterval = null;
            return;
        }
        let pollData = [];
        for (let [chainId, poll] of this.activePolls) {
            pollData.push({ chainId: chainId, segmentIndex: poll.segmentIndex });
        }
        genericRequest('PollChainProgress', { chainData: JSON.stringify(pollData) }, (data) => {
            if (!data.counts) return;
            let maxStalePolls = 600; // 30 min at 3s with no new candidates
            for (let [chainId, poll] of [...this.activePolls]) {
                let candidateCount = data.counts[chainId];
                if (candidateCount === undefined) continue;
                if (candidateCount == -1) {
                    // Chain was deleted
                    this.stopChainPolling(chainId);
                    continue;
                }
                if (candidateCount > poll.lastCount) {
                    poll.lastCount = candidateCount;
                    poll.stalePolls = 0;
                    // If editor is showing this chain, refresh it
                    if (this.activeChain?.chain_id == chainId && this.editorModal.style.display != 'none') {
                        genericRequest('GetVideoChain', { chainId: chainId }, (d) => {
                            if (d.chain && this.activeChain?.chain_id == chainId) {
                                this.activeChain = d.chain;
                                this.renderCandidates();
                                this.renderTimeline();
                            }
                        });
                    }
                } else {
                    poll.stalePolls++;
                }
                if (candidateCount >= poll.expectedCount) {
                    this.stopChainPolling(chainId);
                    doNoticePopover(`"${poll.chainName}" segment ${poll.segmentIndex + 1}: ${candidateCount} candidates ready`, 'notice-pop-green');
                } else if (poll.stalePolls >= maxStalePolls) {
                    this.stopChainPolling(chainId);
                    if (candidateCount > 0) {
                        doNoticePopover(`"${poll.chainName}" segment ${poll.segmentIndex + 1}: ${candidateCount} of ${poll.expectedCount} candidates ready`, 'notice-pop-yellow');
                    }
                }
            }
        });
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
        this.renderKeyframes();
        this._updateStitchedBtn();
        this._updateAddModeUI();

        this.editorModal.style.display = 'flex';
    }

    /** Show or hide the Stitched Videos button based on chain data */
    _updateStitchedBtn() {
        let btn = document.getElementById('video_chain_stitched_btn');
        if (!btn) return;
        let hasStitched = this.activeChain?.stitched_outputs?.length > 0;
        btn.style.display = hasStitched ? '' : 'none';
    }

    /** Open the stitched videos modal */
    openStitchedVideos() {
        if (!this.activeChain) return;
        document.getElementById('video_chain_stitched_chain_name').textContent = this.activeChain.name;
        this.renderStitchedVideos();
        this.editorModal.style.display = 'none';
        this.stitchedModal.style.display = 'flex';
    }

    closeStitchedModal() {
        this.stitchedModal.style.display = 'none';
        this.editorModal.style.display = 'flex';
    }

    /** Render stitched video cards */
    renderStitchedVideos() {
        let grid = document.getElementById('video_chain_stitched_grid');
        grid.innerHTML = '';

        let outputs = this.activeChain?.stitched_outputs || [];
        if (outputs.length == 0) {
            grid.innerHTML = '<p class="video-chain-no-candidates">No stitched videos yet.</p>';
            return;
        }

        for (let i = 0; i < outputs.length; i++) {
            let entry = outputs[i];
            let url = entry.url || entry;
            let videoSrc = url.startsWith('/') ? url : `/${url}`;

            let dateLabel = '';
            if (entry.created) {
                let d = new Date(entry.created);
                dateLabel = d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            }

            let card = document.createElement('div');
            card.className = 'video-chain-stitched-card';
            card.innerHTML = `
                <div class="video-chain-candidate-preview">
                    <video loop muted playsinline>
                        <source src="${videoSrc}" type="video/mp4">
                    </video>
                </div>
                <div class="video-chain-candidate-controls">
                    <span class="video-chain-candidate-label">Stitched ${i + 1}${dateLabel ? ' &mdash; ' + dateLabel : ''}</span>
                    <a class="basic-button video-chain-download-btn" href="${videoSrc}" download>Download</a>
                </div>
            `;

            let video = card.querySelector('video');
            if (video) {
                card.addEventListener('mouseenter', () => video.play());
                card.addEventListener('mouseleave', () => { video.pause(); video.currentTime = 0; });
                card.querySelector('.video-chain-candidate-preview').addEventListener('click', () => {
                    if (typeof imageFullView !== 'undefined') {
                        imageFullView.showImage(videoSrc, '{}', `stitched_${i}`);
                    }
                });
            }

            grid.appendChild(card);
        }
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

        // Build header with init image and end frame keyframe if available
        let header = document.createElement('div');
        header.className = 'video-chain-candidates-header';

        let initImage = currentSegment.init_image;
        let initImageHtml = '';
        if (initImage) {
            let initImageSrc = initImage.startsWith('/') ? initImage : `/${initImage}`;
            initImageHtml = `<img class="video-chain-init-image" src="${initImageSrc}" alt="Init image" onerror="this.style.display='none'" />`;
        }

        let endKeyframeId = currentSegment.end_frame_keyframe_id;
        let endKeyframeHtml = '';
        if (endKeyframeId) {
            let kf = (this.activeChain?.keyframes || []).find(k => k.keyframe_id == endKeyframeId);
            if (kf) {
                let src = kf.image_path.startsWith('/') ? kf.image_path : `/${kf.image_path}`;
                endKeyframeHtml = `<img class="video-chain-init-image" src="${src}" alt="End frame target" onerror="this.style.display='none'" />`;
            }
        }

        header.innerHTML = `
            ${initImageHtml}
            ${endKeyframeHtml}
            <div class="video-chain-header-text">
                <strong>Selecting for Segment ${this.currentSegmentIndex + 1}</strong>
                ${initImage ? '<span class="video-chain-init-label">\u2190 Init image used for this segment</span>' : ''}
                ${endKeyframeHtml ? '<span class="video-chain-init-label">End frame target used for this segment \u2192</span>' : ''}
            </div>
        `;
        container.appendChild(header);

        let candidates = currentSegment.candidates;
        let selectedVideo = currentSegment.selected_video;

        candidates.forEach((candidate, index) => {
            let isSelected = candidate == selectedVideo;
            let card = document.createElement('div');
            card.className = `video-chain-candidate-card ${isSelected ? 'selected' : ''}`;
            card.dataset.video = candidate;

            let videoSrc = candidate.startsWith('/') ? candidate : `/${candidate}`;
            let lastFramePath = this.getLastFramePath(candidate);
            let lastFrameSrc = lastFramePath.startsWith('/') ? lastFramePath : `/${lastFramePath}`;
            let escapedCandidate = candidate.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

            card.innerHTML = `
                <div class="video-chain-candidate-preview">
                    <video loop muted playsinline poster="${lastFrameSrc}">
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

    /** Continue the chain - set last frame as init image, optionally pick an end frame keyframe */
    continueChain() {
        let segments = this.activeChain.segments || [];
        let currentSegment = segments[this.currentSegmentIndex];

        if (!currentSegment || !currentSegment.selected_video) {
            showError('Please select a video for the current segment first');
            return;
        }

        this.ensureLastFrame(currentSegment.selected_video, (lastFramePath) => {
            this.setInitImageFromPath(lastFramePath, () => {
                let keyframes = this.activeChain?.keyframes || [];
                if (keyframes.length > 0) {
                    this.showEndFramePicker();
                } else {
                    this._finishContinue(null);
                }
            });
        });
    }

    /** Show an overlay inside the editor letting the user pick an end frame keyframe (or skip). */
    showEndFramePicker() {
        let keyframes = this.activeChain?.keyframes || [];

        let overlay = document.createElement('div');
        overlay.id = 'video_chain_end_frame_picker';
        overlay.className = 'video-chain-end-frame-picker';

        let thumbsHtml = keyframes.map(kf => {
            let src = kf.image_path.startsWith('/') ? kf.image_path : `/${kf.image_path}`;
            return `
                <div class="video-chain-picker-thumb"
                     onclick="videoChainManager.selectEndFrame('${kf.keyframe_id}')">
                    <img src="${src}" onerror="this.style.opacity='0.3'" />
                </div>
            `;
        }).join('');

        overlay.innerHTML = `
            <div class="video-chain-end-frame-picker-inner">
                <h3>Set end frame? <span class="video-chain-hint">(optional)</span></h3>
                <div class="video-chain-picker-thumbs">${thumbsHtml}</div>
                <div class="video-chain-buttons">
                    <button class="basic-button" onclick="videoChainManager.selectEndFrame(null)">Skip</button>
                </div>
            </div>
        `;

        let editorContent = this.editorModal.querySelector('.video-chain-modal-content');
        editorContent.appendChild(overlay);
    }

    /** Called when the user picks a keyframe (or null to skip) from the end frame picker. */
    selectEndFrame(keyframeId) {
        let overlay = document.getElementById('video_chain_end_frame_picker');
        if (overlay) overlay.remove();
        this._finishContinue(keyframeId);
    }

    /** Complete the continue flow — sets end frame if chosen, stores state, shows continue banner. */
    _finishContinue(endFrameKeyframeId) {
        let endFramePath = null;
        if (endFrameKeyframeId) {
            let kf = (this.activeChain.keyframes || []).find(k => k.keyframe_id == endFrameKeyframeId);
            if (kf) {
                endFramePath = kf.image_path;
                this.setEndFrameFromPath(endFramePath);
            }
        }

        this.pendingEndFramePath = endFramePath;
        this.pendingEndFrameKeyframeId = endFrameKeyframeId;

        this.closeEditorModal(false);

        let nextSegment = this.currentSegmentIndex + 1;
        let candidatesPerSegment = parseInt(document.getElementById('input_images')?.value) || 1;

        this.continuingChainId = this.activeChain.chain_id;
        this.continuingSegmentIndex = nextSegment;
        this.continuingExpectedCount = candidatesPerSegment;

        let endFrameNote = endFramePath ? ' (end frame set)' : '';
        doNoticePopover(`Ready for segment ${nextSegment + 1}${endFrameNote}. Adjust parameters then Generate.`, 'notice-pop-blue');

        this.showContinueBanner(nextSegment + 1);
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

        // Read expected count NOW (at generation time) so user can adjust Images after clicking Continue
        let expectedCount = parseInt(document.getElementById('input_images')?.value) || 1;

        this.generateForChain(
            this.continuingChainId,
            this.continuingSegmentIndex,
            expectedCount,
            this.activeChain?.name,
            this.pendingEndFrameKeyframeId || null,
            this.pendingEndFramePath || null
        );

        // Clear continuation state
        this.continuingChainId = null;
        this.continuingSegmentIndex = null;
        this.continuingExpectedCount = null;
        this.pendingEndFrameKeyframeId = null;
        this.pendingEndFramePath = null;
    }

    cancelContinue() {
        this.hideContinueBanner();
        this.continuingChainId = null;
        this.continuingSegmentIndex = null;
        this.continuingExpectedCount = null;
        this.pendingEndFrameKeyframeId = null;
        this.pendingEndFramePath = null;
        this.openEditorModal();
    }

    /** Render the keyframe strip in the editor */
    renderKeyframes() {
        let strip = document.getElementById('video_chain_keyframes_strip');
        if (!strip) return;
        strip.innerHTML = '';
        let keyframes = this.activeChain?.keyframes || [];
        if (keyframes.length == 0) {
            strip.innerHTML = '<span class="video-chain-keyframe-empty">No keyframes yet</span>';
            return;
        }
        for (let kf of keyframes) {
            let src = kf.image_path.startsWith('/') ? kf.image_path : `/${kf.image_path}`;
            let card = document.createElement('div');
            card.className = 'video-chain-keyframe-card';
            card.dataset.keyframeId = kf.keyframe_id;
            card.innerHTML = `
                <img src="${src}" class="video-chain-keyframe-thumb" onerror="this.style.opacity='0.3'" />
                <button class="video-chain-keyframe-delete"
                        onclick="event.stopPropagation(); videoChainManager.removeKeyframe('${kf.keyframe_id}')">&times;</button>
            `;
            strip.appendChild(card);
        }
    }

    /** Remove a keyframe from the active chain */
    removeKeyframe(keyframeId) {
        if (!confirm('Remove this keyframe?')) return;
        genericRequest('RemoveKeyframe', {
            chainId: this.activeChain.chain_id,
            keyframeId: keyframeId
        }, (data) => {
            if (data.error) { showError(data.error); return; }
            this.activeChain = data.chain;
            this.renderKeyframes();
            doNoticePopover('Keyframe removed.', 'notice-pop-green');
        });
    }

    /** Upload an image file as a keyframe for the active chain */
    uploadKeyframe() {
        if (!this.activeChain) { showError('No active chain'); return; }
        let input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.onchange = (e) => {
            let file = e.target.files[0];
            if (!file) return;
            let reader = new FileReader();
            reader.onload = (ev) => {
                genericRequest('AddKeyframe', {
                    chainId: this.activeChain.chain_id,
                    imageData: ev.target.result
                }, (data) => {
                    if (data.error) { showError(data.error); return; }
                    this.activeChain = data.chain;
                    this.renderKeyframes();
                    doNoticePopover('Image uploaded as keyframe!', 'notice-pop-green');
                });
            };
            reader.readAsDataURL(file);
        };
        input.click();
    }

    /** Begin "save as keyframe" mode for the given video stored URL (uses last frame) */
    startSaveAsKeyframe(videoSrc) {
        if (this.activeChain) {
            this.saveLastFrameAsKeyframe(videoSrc, this.activeChain.chain_id);
        } else {
            this.pendingSaveKeyframeVideoSrc = videoSrc;
            this.pendingSaveKeyframeIsVideo = true;
            this.openChainList();
        }
    }

    /** Begin "save as keyframe" mode for an image stored URL (uses the image directly) */
    startSaveImageAsKeyframe(imageSrc) {
        if (this.activeChain) {
            this._addPathAsKeyframe(imageSrc, this.activeChain.chain_id, 'Image saved as keyframe!');
        } else {
            this.pendingSaveKeyframeVideoSrc = imageSrc;
            this.pendingSaveKeyframeIsVideo = false;
            this.openChainList();
        }
    }

    /** Save the last frame of a video as a keyframe for the given chain */
    saveLastFrameAsKeyframe(videoSrc, chainId) {
        this.ensureLastFrame(videoSrc, (lastFramePath) => {
            this._addPathAsKeyframe(lastFramePath, chainId, 'Last frame saved as keyframe!');
        });
    }

    /** Ensure the last frame image exists for a video, extracting via FFmpeg if FrameSaver didn't create it */
    ensureLastFrame(videoSrc, callback) {
        let lastFramePath = this.getLastFramePath(videoSrc);
        let lastFrameUrl = lastFramePath.startsWith('/') ? lastFramePath : `/${lastFramePath}`;
        fetch(lastFrameUrl, { method: 'HEAD' })
            .then(r => {
                if (r.ok) {
                    callback(lastFramePath);
                } else {
                    genericRequest('EnsureLastFrame', { videoPath: videoSrc }, (data) => {
                        if (data.error) { showError(`Could not get last frame: ${data.error}`); return; }
                        callback(data.last_frame_path);
                    });
                }
            })
            .catch(() => {
                genericRequest('EnsureLastFrame', { videoPath: videoSrc }, (data) => {
                    if (data.error) { showError(`Could not get last frame: ${data.error}`); return; }
                    callback(data.last_frame_path);
                });
            });
    }

    /** Send an already-resolved image path to AddKeyframe */
    _addPathAsKeyframe(imagePath, chainId, successMsg) {
        genericRequest('AddKeyframe', {
            chainId: chainId,
            imagePath: imagePath
        }, (data) => {
            if (data.error) { showError(data.error); return; }
            if (this.activeChain?.chain_id == chainId) {
                this.activeChain = data.chain;
                this.renderKeyframes();
            }
            this.pendingSaveKeyframeVideoSrc = null;
            this.pendingSaveKeyframeIsVideo = false;
            doNoticePopover(successMsg || 'Saved as keyframe!', 'notice-pop-green');
        });
    }

    /** Called when user clicks a chain in the list while in keyframe-save mode */
    _onChainListKeyframeMode(chainId) {
        let src = this.pendingSaveKeyframeVideoSrc;
        let isVideo = this.pendingSaveKeyframeIsVideo;
        document.getElementById('video_chain_list_dialog')?.remove();
        if (isVideo) {
            this.saveLastFrameAsKeyframe(src, chainId);
        } else {
            this._addPathAsKeyframe(src, chainId, 'Image saved as keyframe!');
        }
    }

    /** Set the SwarmUI end frame input from an image stored URL */
    setEndFrameFromPath(imagePath) {
        let imageUrl = imagePath.startsWith('/') ? imagePath : `/${imagePath}`;

        fetch(imageUrl)
            .then(response => {
                if (!response.ok) throw new Error(`End frame not found: ${imagePath}`);
                return response.blob();
            })
            .then(blob => {
                let endFrameParam = document.getElementById('input_videoendimage');
                if (endFrameParam) {
                    let file = new File([blob], 'end_frame.png', { type: 'image/png' });
                    let container = new DataTransfer();
                    container.items.add(file);
                    endFrameParam.files = container.files;
                    triggerChangeFor(endFrameParam);
                    toggleGroupOpen(endFrameParam, true);

                    let toggler = document.getElementById('input_group_content_videoendimage_toggle');
                    if (toggler) {
                        toggler.checked = true;
                        triggerChangeFor(toggler);
                    }
                }
            })
            .catch(err => {
                console.error('VideoChain: Failed to load end frame:', err);
            });
    }

    /** Begin "add to chain" mode with the given stored video URL */
    startAddToChain(videoSrc) {
        this.pendingAddVideoSrc = videoSrc;
        this.openChainList();
    }

    /** Cancel "add to chain" mode */
    cancelAddToChain() {
        this.pendingAddVideoSrc = null;
        this._updateAddModeUI();
        if (this.editorModal && this.editorModal.style.display != 'none') {
            this.closeEditorModal(false);
        }
    }

    /** Show/hide add-mode banner and action buttons based on pendingAddVideoSrc */
    _updateAddModeUI() {
        let isAddMode = !!this.pendingAddVideoSrc;
        let banner = document.getElementById('video_chain_add_banner');
        if (banner) {
            if (isAddMode) {
                let videoDisplaySrc = this.pendingAddVideoSrc.startsWith('/') ? this.pendingAddVideoSrc : `/${this.pendingAddVideoSrc}`;
                let thumb = document.getElementById('video_chain_add_thumb');
                if (thumb) {
                    thumb.src = videoDisplaySrc;
                    thumb.load();
                }
            }
            banner.style.display = isAddMode ? '' : 'none';
        }
        for (let id of ['video_chain_continue_btn', 'video_chain_stitch_btn', 'video_chain_cleanup_btn']) {
            let btn = document.getElementById(id);
            if (btn) btn.style.display = isAddMode ? 'none' : '';
        }
        if (!isAddMode) {
            this._updateStitchedBtn();
        } else {
            let stitchedBtn = document.getElementById('video_chain_stitched_btn');
            if (stitchedBtn) stitchedBtn.style.display = 'none';
        }
        let addSegBtn = document.getElementById('video_chain_add_segment_btn');
        let addEndBtn = document.getElementById('video_chain_add_end_btn');
        if (addSegBtn) addSegBtn.style.display = isAddMode ? '' : 'none';
        if (addEndBtn) addEndBtn.style.display = isAddMode ? '' : 'none';
    }

    /** Add the pending video to the currently-viewed segment */
    addVideoToCurrentSegment() {
        if (!this.pendingAddVideoSrc || !this.activeChain) return;
        genericRequest('AddChainCandidates', {
            chainId: this.activeChain.chain_id,
            segmentIndex: this.currentSegmentIndex,
            candidates: [this.pendingAddVideoSrc]
        }, (data) => {
            if (data.error) { showError(data.error); return; }
            this.activeChain = data.chain;
            this.pendingAddVideoSrc = null;
            this._updateAddModeUI();
            this.renderCandidates();
            this.renderTimeline();
            doNoticePopover(`Video added to segment ${this.currentSegmentIndex + 1}!`, 'notice-pop-green');
        });
    }

    /** Add the pending video as a brand new segment at the end of the chain */
    addVideoToNewEndSegment() {
        if (!this.pendingAddVideoSrc || !this.activeChain) return;
        let newSegIndex = this.activeChain.segments?.length || 0;
        genericRequest('AddChainCandidates', {
            chainId: this.activeChain.chain_id,
            segmentIndex: newSegIndex,
            candidates: [this.pendingAddVideoSrc]
        }, (data) => {
            if (data.error) { showError(data.error); return; }
            this.activeChain = data.chain;
            this.currentSegmentIndex = newSegIndex;
            this.pendingAddVideoSrc = null;
            this._updateAddModeUI();
            this.renderCandidates();
            this.renderTimeline();
            document.getElementById('video_chain_editor_segment').textContent =
                `${newSegIndex + 1}/${data.chain.segments.length}`;
            doNoticePopover('Video added as new end segment!', 'notice-pop-green');
        });
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

            if (data.chain) {
                this.activeChain = data.chain;
            }

            doNoticePopover(`"${this.activeChain.name}" stitched! Click "Stitched Videos" in the editor to view.`, 'notice-pop-green');

            if (data.stitched_url) {
                let videoSrc = data.stitched_url.startsWith('/') ? data.stitched_url : `/${data.stitched_url}`;
                setCurrentImage(videoSrc, '{}', 'chain_final');
            } else if (data.output) {
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
                    let isGenerating = this.activePolls.has(chain.chain_id);

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

                    let chainOnclick = this.pendingSaveKeyframeVideoSrc
                        ? `videoChainManager._onChainListKeyframeMode('${chain.chain_id}');`
                        : `videoChainManager.loadChain('${chain.chain_id}'); document.getElementById('video_chain_list_dialog').remove();`;

                    return `
                        <div class="video-chain-grid-item" data-status="${statusClass}" onclick="${chainOnclick}">
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

            let addModeBannerHtml = '';
            if (this.pendingSaveKeyframeVideoSrc) {
                let displayPath = this.pendingSaveKeyframeIsVideo
                    ? this.getLastFramePath(this.pendingSaveKeyframeVideoSrc)
                    : this.pendingSaveKeyframeVideoSrc;
                let frameDisplaySrc = displayPath.startsWith('/') ? displayPath : `/${displayPath}`;
                addModeBannerHtml = `
                    <div class="video-chain-add-banner">
                        <div class="video-chain-add-banner-inner">
                            <img class="video-chain-add-thumb" src="${frameDisplaySrc}" onerror="this.style.display='none'" />
                            <span class="video-chain-add-text">Select a chain to save this frame as a keyframe</span>
                        </div>
                        <button class="basic-button video-chain-add-cancel-btn" onclick="videoChainManager.pendingSaveKeyframeVideoSrc=null; videoChainManager.closeChainList();">&times; Cancel</button>
                    </div>`;
            } else if (this.pendingAddVideoSrc) {
                let videoDisplaySrc = this.pendingAddVideoSrc.startsWith('/') ? this.pendingAddVideoSrc : `/${this.pendingAddVideoSrc}`;
                addModeBannerHtml = `
                    <div class="video-chain-add-banner">
                        <div class="video-chain-add-banner-inner">
                            <video class="video-chain-add-thumb" loop muted playsinline autoplay src="${videoDisplaySrc}"></video>
                            <span class="video-chain-add-text">Select a chain to add this video to</span>
                        </div>
                        <button class="basic-button video-chain-add-cancel-btn" onclick="videoChainManager.cancelAddToChain(); videoChainManager.closeChainList();">&times; Cancel</button>
                    </div>`;
            }
            let listTitle = this.pendingSaveKeyframeVideoSrc ? 'Save Frame as Keyframe'
                : (this.pendingAddVideoSrc ? 'Add Video to Chain' : 'Your Video Chains');

            let listDialog = document.createElement('div');
            listDialog.className = 'video-chain-modal';
            listDialog.id = 'video_chain_list_dialog';
            let isNormalMode = !this.pendingSaveKeyframeVideoSrc && !this.pendingAddVideoSrc;
            let filterBarHtml = '';
            if (isNormalMode && chains.length > 0) {
                filterBarHtml = `
                    <div class="video-chain-filter-bar">
                        <button class="video-chain-filter-btn active" data-filter="all" onclick="videoChainManager.filterChainList('all', this)">All</button>
                        <button class="video-chain-filter-btn" data-filter="status-new" onclick="videoChainManager.filterChainList('status-new', this)">New</button>
                        <button class="video-chain-filter-btn" data-filter="status-waiting" onclick="videoChainManager.filterChainList('status-waiting', this)">Waiting for Selection</button>
                        <button class="video-chain-filter-btn" data-filter="status-ready" onclick="videoChainManager.filterChainList('status-ready', this)">Ready to Continue</button>
                        <button class="video-chain-filter-btn" data-filter="status-generating" onclick="videoChainManager.filterChainList('status-generating', this)">Generating</button>
                        <button class="video-chain-filter-btn" data-filter="status-stitched" onclick="videoChainManager.filterChainList('status-stitched', this)">Stitched</button>
                    </div>`;
            }

            listDialog.innerHTML = `
                <div class="video-chain-modal-content video-chain-list-modal">
                    <button class="video-chain-close-x" onclick="videoChainManager.closeChainList()">&times;</button>
                    ${addModeBannerHtml}
                    <h2>${listTitle}</h2>
                    ${filterBarHtml}
                    <div class="video-chain-grid">${gridHtml}</div>
                    <div class="video-chain-buttons">
                        <button class="basic-button" onclick="videoChainManager.closeChainList()">Close</button>
                    </div>
                </div>
            `;
            listDialog.style.display = 'flex';
            document.body.appendChild(listDialog);

            // Restore active filter if one was set before the list was rebuilt
            if (this._chainListFilter && this._chainListFilter != 'all') {
                let btn = listDialog.querySelector(`.video-chain-filter-btn[data-filter="${this._chainListFilter}"]`);
                if (btn) this.filterChainList(this._chainListFilter, btn);
            }
        });
    }

    /** Dismiss the chain list and clear the active chain (user has backed out entirely) */
    closeChainList() {
        document.getElementById('video_chain_list_dialog')?.remove();
        this.activeChain = null;
    }

    /** Filter the chain list grid by status class, or 'all' to show everything */
    filterChainList(statusClass, btn) {
        this._chainListFilter = statusClass;
        let items = document.querySelectorAll('#video_chain_list_dialog .video-chain-grid-item');
        for (let item of items) {
            item.style.display = (statusClass == 'all' || item.dataset.status == statusClass) ? '' : 'none';
        }
        let btns = document.querySelectorAll('#video_chain_list_dialog .video-chain-filter-btn');
        for (let b of btns) {
            b.classList.toggle('active', b == btn);
        }
    }

    deleteChainPrompt(chainId) {
        if (confirm('Delete this chain? You can choose to keep or delete the video files.')) {
            let deleteVideos = confirm('Also delete the video files?');
            this.deleteChain(chainId, deleteVideos);
        }
    }

    deleteChain(chainId, deleteVideos) {
        this.stopChainPolling(chainId);

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
