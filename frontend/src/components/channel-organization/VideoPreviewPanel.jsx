import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Box, CloseButton, Flex, Loader, Text } from '@mantine/core';
import useVideoStore from '../../store/useVideoStore';
import mpegts from 'mpegts.js';

const VideoPreviewPanel = () => {
    const isVisible = useVideoStore((s) => s.isVisible);
    const streamUrl = useVideoStore((s) => s.streamUrl);
    const contentType = useVideoStore((s) => s.contentType);
    const metadata = useVideoStore((s) => s.metadata);
    const hideVideo = useVideoStore((s) => s.hideVideo);
    const videoRef = useRef(null);
    const playerRef = useRef(null);
    const [isLoading, setIsLoading] = useState(false);
    const [loadError, setLoadError] = useState(null);
    const [showOverlay, setShowOverlay] = useState(true);
    const overlayTimeoutRef = useRef(null);

    // Safely destroy the mpegts player to prevent errors
    const safeDestroyPlayer = useCallback(() => {
        try {
            if (playerRef.current) {
                setIsLoading(false);
                setLoadError(null);

                if (videoRef.current) {
                    videoRef.current.removeAttribute('src');
                    videoRef.current.load();
                }

                try {
                    playerRef.current.pause();
                } catch (e) {
                    // Ignore pause errors
                }

                try {
                    playerRef.current.destroy();
                } catch (error) {
                    if (
                        error.name !== 'AbortError' &&
                        !error.message?.includes('aborted')
                    ) {
                        console.log('Error during player destruction:', error.message);
                    }
                } finally {
                    playerRef.current = null;
                }
            }
        } catch (error) {
            console.log('Error during player cleanup:', error);
            playerRef.current = null;
        }

        // Clear overlay timer
        if (overlayTimeoutRef.current) {
            clearTimeout(overlayTimeoutRef.current);
            overlayTimeoutRef.current = null;
        }
    }, []);

    // Start overlay auto-hide timer
    const startOverlayTimer = useCallback(() => {
        if (overlayTimeoutRef.current) {
            clearTimeout(overlayTimeoutRef.current);
        }
        overlayTimeoutRef.current = setTimeout(() => {
            setShowOverlay(false);
        }, 4000); // Hide after 4 seconds
    }, []);

    // Initialize VOD player (native HTML5 with enhanced controls)
    const initializeVODPlayer = useCallback(() => {
        if (!videoRef.current || !streamUrl) return;

        setIsLoading(true);
        setLoadError(null);
        setShowOverlay(true); // Show overlay initially

        console.log('Initializing VOD player for:', streamUrl);

        const video = videoRef.current;

        // Enhanced video element configuration for VOD
        video.preload = 'metadata';
        video.crossOrigin = 'anonymous';

        // Set up event listeners
        const handleLoadStart = () => setIsLoading(true);
        const handleLoadedData = () => setIsLoading(false);
        const handleCanPlay = () => {
            setIsLoading(false);
            // Auto-play for VOD content
            video.play().catch((e) => {
                console.log('Auto-play prevented:', e);
                setLoadError('Auto-play was prevented. Click play to start.');
            });
            // Start overlay timer when video is ready
            startOverlayTimer();
        };
        const handleError = (e) => {
            setIsLoading(false);
            const error = e.target.error;
            let errorMessage = 'Video playback error';

            if (error) {
                switch (error.code) {
                    case error.MEDIA_ERR_ABORTED:
                        errorMessage = 'Video playback was aborted';
                        break;
                    case error.MEDIA_ERR_NETWORK:
                        errorMessage = 'Network error while loading video';
                        break;
                    case error.MEDIA_ERR_DECODE:
                        errorMessage = 'Video codec not supported by your browser';
                        break;
                    case error.MEDIA_ERR_SRC_NOT_SUPPORTED:
                        errorMessage = 'Video format not supported by your browser';
                        break;
                    default:
                        errorMessage = error.message || 'Unknown video error';
                }
            }

            setLoadError(errorMessage);
        };

        // Add event listeners
        video.addEventListener('loadstart', handleLoadStart);
        video.addEventListener('loadeddata', handleLoadedData);
        video.addEventListener('canplay', handleCanPlay);
        video.addEventListener('error', handleError);

        // Set the source
        video.src = streamUrl;
        video.load();

        // Store cleanup function
        playerRef.current = {
            destroy: () => {
                video.removeEventListener('loadstart', handleLoadStart);
                video.removeEventListener('loadeddata', handleLoadedData);
                video.removeEventListener('canplay', handleCanPlay);
                video.removeEventListener('error', handleError);
                video.removeAttribute('src');
                video.load();
            },
        };
    }, [streamUrl, startOverlayTimer]);

    // Initialize live stream player (mpegts.js)
    const initializeLivePlayer = useCallback(() => {
        if (!videoRef.current || !streamUrl) return;

        setIsLoading(true);
        setLoadError(null);

        console.log('Initializing live stream player for:', streamUrl);

        try {
            if (!mpegts.getFeatureList().mseLivePlayback) {
                setIsLoading(false);
                setLoadError(
                    "Your browser doesn't support live video streaming. Please try Chrome or Edge."
                );
                return;
            }

            const player = mpegts.createPlayer({
                type: 'mpegts',
                url: streamUrl,
                isLive: true,
                enableWorker: true,
                enableStashBuffer: false,
                liveBufferLatencyChasing: true,
                liveSync: true,
                cors: true,
                autoCleanupSourceBuffer: true,
                autoCleanupMaxBackwardDuration: 10,
                autoCleanupMinBackwardDuration: 5,
                reuseRedirectedURL: true,
            });

            player.attachMediaElement(videoRef.current);

            player.on(mpegts.Events.LOADING_COMPLETE, () => {
                setIsLoading(false);
            });

            player.on(mpegts.Events.METADATA_ARRIVED, () => {
                setIsLoading(false);
            });

            player.on(mpegts.Events.ERROR, (errorType, errorDetail) => {
                setIsLoading(false);

                if (errorType !== 'NetworkError' || !errorDetail?.includes('aborted')) {
                    console.error('Player error:', errorType, errorDetail);

                    let errorMessage = `Error: ${errorType}`;

                    if (errorType === 'MediaError') {
                        const errorString = errorDetail?.toLowerCase() || '';

                        if (
                            errorString.includes('audio') ||
                            errorString.includes('ac3') ||
                            errorString.includes('ac-3')
                        ) {
                            errorMessage =
                                'Audio codec not supported by your browser. Try Chrome or Edge for better audio codec support.';
                        } else if (
                            errorString.includes('video') ||
                            errorString.includes('h264') ||
                            errorString.includes('h.264')
                        ) {
                            errorMessage =
                                'Video codec not supported by your browser. Try Chrome or Edge for better video codec support.';
                        } else if (errorString.includes('mse')) {
                            errorMessage =
                                "Your browser doesn't support the codecs used in this stream. Try Chrome or Edge for better compatibility.";
                        } else {
                            errorMessage =
                                'Media codec not supported by your browser. This may be due to unsupported audio (AC3) or video codecs. Try Chrome or Edge.';
                        }
                    } else if (errorDetail) {
                        errorMessage += ` - ${errorDetail}`;
                    }

                    setLoadError(errorMessage);
                }
            });

            player.load();

            player.on(mpegts.Events.MEDIA_INFO, () => {
                setIsLoading(false);
                try {
                    player.play().catch((e) => {
                        console.log('Auto-play prevented:', e);
                        setLoadError('Auto-play was prevented. Click play to start.');
                    });
                } catch (e) {
                    console.log('Error during play:', e);
                    setLoadError(`Playback error: ${e.message}`);
                }
            });

            playerRef.current = player;
        } catch (error) {
            setIsLoading(false);
            console.error('Error initializing player:', error);

            if (
                error.message?.includes('codec') ||
                error.message?.includes('format')
            ) {
                setLoadError(
                    'Codec not supported by your browser. Please try a different browser (Chrome/Edge recommended).'
                );
            } else {
                setLoadError(`Initialization error: ${error.message}`);
            }
        }
    }, [streamUrl]);

    useEffect(() => {
        if (!isVisible || !streamUrl) {
            safeDestroyPlayer();
            return;
        }

        // Clean up any existing player
        safeDestroyPlayer();

        // Initialize the appropriate player based on content type
        if (contentType === 'vod') {
            initializeVODPlayer();
        } else {
            initializeLivePlayer();
        }

        // Cleanup when component unmounts or streamUrl changes
        return () => {
            safeDestroyPlayer();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isVisible, streamUrl, contentType]);

    // Modified hideVideo handler to clean up player first
    const handleClose = (e) => {
        if (e) {
            e.stopPropagation();
            e.preventDefault();
        }
        safeDestroyPlayer();
        setTimeout(() => {
            hideVideo();
        }, 50);
    };

    // If the video is hidden or no URL is selected, do not render
    if (!isVisible || !streamUrl) {
        return null;
    }

    return (
        <Box
            style={{
                borderTop: '1px solid var(--mantine-color-dark-4)',
                backgroundColor: '#1a1b1e',
                display: 'flex',
                flexDirection: 'column',
                flexShrink: 0,
            }}
        >
            {/* Header with close button */}
            <Flex
                justify="space-between"
                align="center"
                px="sm"
                py={4}
                style={{
                    borderBottom: '1px solid var(--mantine-color-dark-4)',
                }}
            >
                <Text fw={600} size="sm">
                    Preview
                </Text>
                <CloseButton
                    onClick={handleClose}
                    size="sm"
                />
            </Flex>

            {/* Video container with aspect ratio */}
            <Box
                style={{
                    position: 'relative',
                    width: '100%',
                    aspectRatio: '16 / 9',
                    display: 'flex',
                    flexDirection: 'column',
                }}
                onMouseEnter={() => {
                    if (contentType === 'vod' && !isLoading) {
                        setShowOverlay(true);
                        if (overlayTimeoutRef.current) {
                            clearTimeout(overlayTimeoutRef.current);
                        }
                    }
                }}
                onMouseLeave={() => {
                    if (contentType === 'vod' && !isLoading) {
                        startOverlayTimer();
                    }
                }}
            >
                {/* Enhanced video element with better controls for VOD */}
                <video
                    ref={videoRef}
                    controls
                    style={{
                        width: '100%',
                        height: '100%',
                        backgroundColor: '#000',
                        // Better controls styling for VOD
                        ...(contentType === 'vod' && {
                            controlsList: 'nodownload',
                            playsInline: true,
                        }),
                    }}
                    // Add poster for VOD if available
                    {...(contentType === 'vod' && {
                        poster: metadata?.logo?.url, // Use VOD poster if available
                    })}
                />

                {/* VOD title overlay when not loading - auto-hides after 4 seconds */}
                {!isLoading && metadata && contentType === 'vod' && showOverlay && (
                    <Box
                        style={{
                            position: 'absolute',
                            top: 0,
                            left: 0,
                            right: 0,
                            background: 'linear-gradient(rgba(0,0,0,0.8), transparent)',
                            padding: '10px 10px 20px',
                            color: 'white',
                            pointerEvents: 'none', // Allow clicks to pass through to video controls
                            transition: 'opacity 0.3s ease-in-out',
                            opacity: showOverlay ? 1 : 0,
                        }}
                    >
                        <Text
                            size="sm"
                            weight={500}
                            style={{ textShadow: '1px 1px 2px rgba(0,0,0,0.8)' }}
                        >
                            {metadata.name}
                        </Text>
                        {metadata.year && (
                            <Text
                                size="xs"
                                color="dimmed"
                                style={{ textShadow: '1px 1px 2px rgba(0,0,0,0.8)' }}
                            >
                                {metadata.year}
                            </Text>
                        )}
                    </Box>
                )}

                {/* Loading overlay - only show when loading */}
                {isLoading && (
                    <Box
                        style={{
                            position: 'absolute',
                            top: 0,
                            left: 0,
                            width: '100%',
                            height: '100%',
                            backgroundColor: 'rgba(0, 0, 0, 0.7)',
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            justifyContent: 'center',
                            zIndex: 5,
                        }}
                    >
                        <Loader color="cyan" size="md" />
                        <Text color="white" size="sm" mt={10}>
                            Loading {contentType === 'vod' ? 'video' : 'stream'}...
                        </Text>
                    </Box>
                )}

                {/* Error message overlay */}
                {!isLoading && loadError && (
                    <Box
                        style={{
                            position: 'absolute',
                            bottom: 0,
                            left: 0,
                            right: 0,
                            padding: '10px',
                            backgroundColor: 'rgba(45, 27, 46, 0.95)',
                            borderTop: '1px solid #444',
                        }}
                    >
                        <Text color="red" size="xs" style={{ textAlign: 'center' }}>
                            {loadError}
                        </Text>
                    </Box>
                )}
            </Box>
        </Box>
    );
};

export default VideoPreviewPanel;
