import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useDraggable, useDndMonitor, useDroppable } from '@dnd-kit/core';
import { useDebounce, copyToClipboard } from '../../utils';
import {
    Box,
    TextInput,
    Stack,
    Group,
    Text,
    ScrollArea,
    Select,
    ActionIcon,
    Badge,
    Menu,
    UnstyledButton,
    Modal,
} from '@mantine/core';
import {
    IconSearch,
    IconChevronRight,
    IconChevronDown,
    IconFolder,
    IconGripVertical,
    IconEye,
    IconRefresh,
    IconX,
    IconDots,
    IconCopy,
    IconTrash,
} from '@tabler/icons-react';
import API from '../../api';
import useChannelsStore from '../../store/channels';
import usePlaylistsStore from '../../store/playlists';
import useVideoStore from '../../store/useVideoStore';
import useSettingsStore from '../../store/settings';
import { db, syncStreamsToLocalDb, getLocalGroups, clearStreamsInLocalDb } from '../../utils/localDb';
import { Pagination, Loader, Button, Center, Progress } from '@mantine/core';
import { notifications } from '@mantine/notifications';

const StreamItem = React.memo(({ stream, showVideo, env_mode, onDelete, disabled }) => {
    const handleWatchStream = useCallback(() => {
        if (!stream) return;
        const streamHash = stream.stream_hash || stream.id;
        let vidUrl = `/proxy/ts/stream/${streamHash}`;
        if (env_mode === 'dev') {
            vidUrl = `${window.location.protocol}//${window.location.hostname}:5656${vidUrl}`;
        }
        showVideo(vidUrl);
    }, [stream, showVideo, env_mode]);

    const getStreamURL = useCallback(() => {
        if (!stream) return '';
        const streamHash = stream.stream_hash || stream.id;
        let vidUrl = `/proxy/ts/stream/${streamHash}`;
        if (env_mode === 'dev') {
            vidUrl = `${window.location.protocol}//${window.location.hostname}:5656${vidUrl}`;
        }
        return vidUrl;
    }, [stream, env_mode]);

    const handleCopyURL = useCallback((e) => {
        e.stopPropagation();
        copyToClipboard(getStreamURL());
    }, [getStreamURL]);

    const handleCopyTvgId = useCallback((e) => {
        e.stopPropagation();
        if (stream.tvg_id) {
            copyToClipboard(stream.tvg_id);
        }
    }, [stream.tvg_id]);

    const handleCopyGracenoteId = useCallback((e) => {
        e.stopPropagation();
        const gracenoteId = stream.custom_properties?.gracenote_id || stream.custom_properties?.tvc_guide_stationid;
        if (gracenoteId) {
            copyToClipboard(gracenoteId);
        }
    }, [stream.custom_properties]);

    const handleDelete = useCallback((e) => {
        e.stopPropagation();
        if (onDelete) {
            onDelete(stream.id);
        }
    }, [stream.id, onDelete]);

    const dragData = useMemo(() => ({
        type: 'stream',
        streamId: stream.id,
        streamName: stream.name,
    }), [stream.id, stream.name]);

    const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
        id: `stream-${stream.id}`,
        data: dragData,
        disabled: disabled,
    });

    return (
        <Group
            ref={setNodeRef}
            gap="xs"
            px="xs"
            py={4}
            {...(disabled ? {} : listeners)}
            {...(disabled ? {} : attributes)}
            style={{
                cursor: disabled ? 'default' : (isDragging ? 'grabbing' : 'grab'),
                borderRadius: 4,
                transition: 'background-color 0.1s ease',
                opacity: disabled ? 0.5 : (isDragging ? 0.4 : 1),
                flexWrap: 'nowrap',
            }}
            className="stream-item-hover"
            onDoubleClick={handleWatchStream}
        >
            <ActionIcon
                size="xs"
                variant="transparent"
                color="gray.5"
                style={{ pointerEvents: 'none' }}
            >
                <IconGripVertical size={12} />
            </ActionIcon>
            <Box style={{ flex: 1, minWidth: 0 }}>
                <Group gap={6} wrap="nowrap">
                    <Text size="xs" truncate style={{ flex: 1 }}>
                        {stream.name}
                    </Text>
                    {stream.tvg_id && (
                        <Text size="xs" c="dimmed" style={{ flexShrink: 0, fontSize: '10px' }}>
                            {stream.tvg_id}
                        </Text>
                    )}
                </Group>
            </Box>
            <Menu position="bottom-end" withinPortal>
                <Menu.Target>
                    <ActionIcon
                        size="xs"
                        variant="subtle"
                        color="gray"
                        className="row-action-btn"
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => e.stopPropagation()}
                        style={{ opacity: 0 }} // Hidden by default, shown on hover via CSS
                    >
                        <IconDots size={14} />
                    </ActionIcon>
                </Menu.Target>
                <Menu.Dropdown>
                    <Menu.Item
                        leftSection={<IconEye size={14} />}
                        onClick={(e) => {
                            e.stopPropagation();
                            handleWatchStream();
                        }}
                    >
                        Preview
                    </Menu.Item>
                    <Menu.Item
                        leftSection={<IconCopy size={14} />}
                        onClick={handleCopyURL}
                    >
                        Copy URL
                    </Menu.Item>
                    <Menu.Item
                        leftSection={<IconCopy size={14} />}
                        onClick={handleCopyTvgId}
                        disabled={!stream.tvg_id}
                    >
                        Copy TVG-ID
                    </Menu.Item>
                    <Menu.Item
                        leftSection={<IconCopy size={14} />}
                        onClick={handleCopyGracenoteId}
                        disabled={!stream.custom_properties?.gracenote_id && !stream.custom_properties?.tvc_guide_stationid}
                    >
                        Copy Gracenote ID
                    </Menu.Item>
                    <Menu.Divider />
                    <Menu.Item
                        leftSection={<IconTrash size={14} />}
                        color="red"
                        onClick={handleDelete}
                    >
                        Delete Stream
                    </Menu.Item>
                </Menu.Dropdown>
            </Menu>
        </Group>
    );
});

const StreamGroup = React.memo(({ groupName, streams, defaultOpen = false, onDeleteStream, disabled }) => {
    const [open, setOpen] = useState(defaultOpen);
    const showVideo = useVideoStore((s) => s.showVideo);
    const env_mode = useSettingsStore((s) => s.environment.env_mode);

    const dragData = useMemo(() => ({
        type: 'stream-group',
        groupName,
        streamIds: (streams || []).map(s => s.id),
    }), [groupName, streams]);

    const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
        id: `stream-group-${groupName}`,
        data: dragData,
        disabled: disabled,
    });



    return (
        <Box>
            <Group
                ref={setNodeRef}
                gap="xs"
                p="xs"
                {...(disabled ? {} : listeners)}
                {...(disabled ? {} : attributes)}
                style={{
                    cursor: disabled ? 'pointer' : (isDragging ? 'grabbing' : 'pointer'),
                    borderRadius: 4,
                    userSelect: 'none',
                    opacity: disabled ? 0.5 : (isDragging ? 0.4 : 1),
                }}
                className="stream-group-hover"
                onClick={() => setOpen(!open)}
            >
                {open ? (
                    <IconChevronDown size={14} />
                ) : (
                    <IconChevronRight size={14} />
                )}
                <IconFolder size={14} />
                <Text size="sm" fw={500} style={{ flex: 1 }} truncate>
                    {groupName}
                </Text>
                <Badge size="xs" variant="light" color="gray">
                    {streams.length}
                </Badge>
            </Group>
            {/* Only render children when open — prevents draggable registration when collapsed */}
            {open && (
                <Box pl="lg">
                    {streams.map((stream) => (
                        <StreamItem key={stream.id} stream={stream} showVideo={showVideo} env_mode={env_mode} onDelete={onDeleteStream} disabled={disabled} />
                    ))}
                </Box>
            )}
        </Box>
    );
});

const LibrarySearch = React.memo(({ initialValue, onSearchChange }) => {
    const [value, setValue] = useState(initialValue);
    const debouncedValue = useDebounce(value, 350);

    useEffect(() => {
        onSearchChange(debouncedValue);
    }, [debouncedValue, onSearchChange]);

    return (
        <TextInput
            placeholder="Search streams..."
            leftSection={<IconSearch size={14} />}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            size="xs"
        />
    );
});

const StreamLibraryPanel = ({ selectedGroup }) => {
    const [streamsByGroup, setStreamsByGroup] = useState([]);
    const [loading, setLoading] = useState(false);
    const [syncing, setSyncing] = useState(false);
    const [syncProgress, setSyncProgress] = useState(0);
    const [debouncedSearch, setDebouncedSearch] = useState('');
    const [selectedSource, setSelectedSource] = useState(null);
    const [usageFilter, setUsageFilter] = useState('none'); // 'none', 'hide-any', 'hide-profile-{profileId}'
    const [page, setPage] = useState(1);
    const [totalGroups, setTotalGroups] = useState(0);
    const [forceRefresh, setForceRefresh] = useState(0);
    const [usedStreamIds, setUsedStreamIds] = useState(new Set()); // Stream IDs used in filtered channels
    const [isDraggingStream, setIsDraggingStream] = useState(false); // Track if a stream is being dragged
    const [streamUsageCache, setStreamUsageCache] = useState({}); // Cache for stream usage by filter type
    const [deleteModalOpen, setDeleteModalOpen] = useState(false);
    const [streamToDelete, setStreamToDelete] = useState(null);
    const [deleteCheckLoading, setDeleteCheckLoading] = useState(false);
    const [streamUsageInfo, setStreamUsageInfo] = useState(null);
    const GROUPS_PER_PAGE = 30;

    const channelGroups = useChannelsStore((s) => s.channelGroups);
    const fetchChannelGroups = useChannelsStore((s) => s.fetchChannelGroups);
    const playlists = usePlaylistsStore((s) => s.playlists);
    const fetchPlaylists = usePlaylistsStore((s) => s.fetchPlaylists);
    const selectedProfileId = useChannelsStore((s) => s.selectedProfileId);
    const profiles = useChannelsStore((s) => s.profiles);

    // Monitor drag events to show/hide cancel overlay
    useDndMonitor({
        onDragStart(event) {
            const type = event.active.data.current?.type;
            if (type === 'stream' || type === 'stream-group') {
                setIsDraggingStream(true);
            }
        },
        onDragEnd() {
            setIsDraggingStream(false);
        },
        onDragCancel() {
            setIsDraggingStream(false);
        },
    });

    // Cancel drop zone
    const { setNodeRef: setCancelRef, isOver: isCancelOver } = useDroppable({
        id: 'stream-library-cancel',
        data: {
            type: 'cancel',
        },
    });

    useEffect(() => {
        if (!playlists || playlists.length === 0) {
            fetchPlaylists();
        }
        if (Object.keys(channelGroups).length === 0) {
            fetchChannelGroups();
        }
        initStorageAndSync();
    }, []);

    // Fetch stream usage when usageFilter changes
    useEffect(() => {
        if (usageFilter === 'none') {
            setUsedStreamIds(new Set());
            return;
        }

        // Check cache first (5 minute TTL)
        const cacheKey = usageFilter;
        const cached = streamUsageCache[cacheKey];
        const now = Date.now();
        if (cached && (now - cached.timestamp < 5 * 60 * 1000)) {
            console.log('[StreamLibrary] Using cached stream usage for', usageFilter);
            setUsedStreamIds(cached.streamIds);
            return;
        }

        // Fetch stream usage
        fetchStreamUsage(usageFilter);
    }, [usageFilter]);

    useEffect(() => {
        loadLocalGroups();
    }, [debouncedSearch, selectedSource, usageFilter, page, channelGroups, forceRefresh, usedStreamIds]);

    const fetchStreamUsage = async (filterValue) => {
        try {
            console.log('[StreamLibrary] Fetching stream usage for filter:', filterValue);

            let params = new URLSearchParams();

            if (filterValue === 'hide-any') {
                // Fetch all channels, but only get stream IDs
                params.append('page_size', '10000');
            } else if (filterValue.startsWith('hide-profile-')) {
                const profileId = filterValue.replace('hide-profile-', '');
                params.append('channel_profile_id', profileId);
                params.append('page_size', '10000');
            }

            const response = await API.queryChannels(params);
            const channels = response?.results || [];

            // Extract only the stream IDs (much smaller data set)
            const streamIds = new Set();
            channels.forEach(channel => {
                if (channel.streams && Array.isArray(channel.streams)) {
                    channel.streams.forEach(stream => {
                        const streamId = typeof stream === 'object' ? stream.id : stream;
                        streamIds.add(streamId);
                    });
                }
            });

            console.log(`[StreamLibrary] Found ${streamIds.size} used stream IDs for filter ${filterValue}`);

            // Update cache
            setStreamUsageCache(prev => ({
                ...prev,
                [filterValue]: {
                    streamIds,
                    timestamp: Date.now()
                }
            }));

            setUsedStreamIds(streamIds);
        } catch (error) {
            console.error('[StreamLibrary] Failed to fetch stream usage:', error);
            setUsedStreamIds(new Set());
        }
    };

    const initStorageAndSync = async () => {
        try {
            console.log('[StreamLibrary] Checking local DB status...');
            await db.open();
            const count = await db.streams.count();
            console.log('[StreamLibrary] Current stream count in local DB:', count);

            // Always kick off a sync when the organize tab loads
            console.log('[StreamLibrary] Initiating sync on tab load...');

            // If we have existing data, show it immediately while syncing in background
            if (count > 0) {
                setForceRefresh(prev => prev + 1);
            }

            // Start the sync (will run in background)
            await performSync();
        } catch (error) {
            console.error('[StreamLibrary] Failed to initialize local storage:', error);
            // Re-throw to handle in UI if needed, but for now we just log
        }
    };

    const performSync = async () => {
        if (syncing) return;
        setSyncing(true);
        setSyncProgress(0);
        console.log('[StreamLibrary] Starting background sync...');
        try {
            const countResponse = await API.queryStreams(new URLSearchParams({ page_size: '1', page: '1' }));
            if (!countResponse || typeof countResponse.count === 'undefined') {
                throw new Error('Could not get total stream count from API');
            }

            const totalCount = countResponse.count;
            console.log(`[StreamLibrary] Server reports ${totalCount} total streams.`);

            const batchSize = 5000;
            const totalPages = Math.ceil(totalCount / batchSize);

            await clearStreamsInLocalDb();
            console.log('[StreamLibrary] Cleared local DB for fresh sync.');

            for (let i = 0; i < totalPages; i++) {
                console.log(`[StreamLibrary] Fetching batch ${i + 1}/${totalPages}...`);
                const params = new URLSearchParams({
                    page: String(i + 1),
                    page_size: String(batchSize)
                });
                const response = await API.queryStreams(params);
                if (response?.results) {
                    await syncStreamsToLocalDb(response.results);
                }
                setSyncProgress(Math.round(((i + 1) / totalPages) * 100));

                // Refresh the UI every few batches so groups appear while syncing
                if (i % 2 === 0 || i === totalPages - 1) {
                    setForceRefresh(prev => prev + 1);
                }
            }
            console.log('[StreamLibrary] Sync completed successfully.');
        } catch (error) {
            console.error('[StreamLibrary] Background sync failed:', error);
            // Optionally show a notification
        } finally {
            setSyncing(false);
        }
    };

    const loadLocalGroups = async () => {
        // If we are currently syncing and have no data, don't show "No streams found" immediately
        // but let it load as batches come in.
        setLoading(true);
        try {
            console.log(`[StreamLibrary] Loading groups (Page: ${page}, Search: "${debouncedSearch}", Source: "${selectedSource}", Filter: "${usageFilter}")`);
            const { groups, total } = await getLocalGroups({
                search: debouncedSearch,
                source: selectedSource,
                limit: GROUPS_PER_PAGE,
                offset: (page - 1) * GROUPS_PER_PAGE,
                channelGroupsMap: channelGroups
            });

            // Apply usage filtering client-side
            let filteredGroups = groups;
            if (usageFilter !== 'none' && usedStreamIds.size > 0) {
                // Filter out used streams from each group
                const beforeFilterCount = groups.reduce((sum, [_, streams]) => sum + streams.length, 0);
                filteredGroups = groups.map(([groupName, streams]) => {
                    const filteredStreams = streams.filter(stream => !usedStreamIds.has(stream.id));
                    return [groupName, filteredStreams];
                }).filter(([_, streams]) => streams.length > 0); // Remove empty groups
                const afterFilterCount = filteredGroups.reduce((sum, [_, streams]) => sum + streams.length, 0);
                console.log(`[StreamLibrary] Filtered ${beforeFilterCount} streams down to ${afterFilterCount} streams (${usedStreamIds.size} used stream IDs)`);
            }


            console.log(`[StreamLibrary] Received ${filteredGroups.length} groups from LocalDB. Total matching: ${total}`);
            setStreamsByGroup(filteredGroups);
            setTotalGroups(total);
        } catch (error) {
            console.error('[StreamLibrary] Failed to load local groups:', error);
        } finally {
            setLoading(false);
        }
    };

    const handleDeleteStream = async (streamId) => {
        setStreamToDelete(streamId);
        setDeleteModalOpen(true);
        setDeleteCheckLoading(true);
        setStreamUsageInfo(null);

        try {
            // Use efficient backend API to check usage
            const usageData = await API.checkStreamUsage(streamId);

            setStreamUsageInfo({
                count: usageData.channel_count || 0,
                channels: usageData.channels || [],
            });
        } catch (error) {
            console.error('[StreamLibrary] Failed to check stream usage:', error);
            setStreamUsageInfo({ count: 0, channels: [] });
        } finally {
            setDeleteCheckLoading(false);
        }
    };

    const confirmDeleteStream = async () => {
        if (!streamToDelete) return;

        // Store the stream data for potential rollback
        let deletedStreamData = null;

        try {
            // Get the stream from local DB before deleting
            const streamFromDb = await db.streams.get(streamToDelete);
            deletedStreamData = streamFromDb;

            // OPTIMISTIC: Delete from local DB immediately
            await db.streams.delete(streamToDelete);

            // Refresh the UI
            await loadLocalGroups();

            // Close modal immediately for better UX
            setDeleteModalOpen(false);

            // Show optimistic notification
            notifications.show({
                id: `delete-stream-${streamToDelete}`,
                title: 'Deleting Stream...',
                message: 'Stream removed from library',
                color: 'blue',
                loading: true,
                autoClose: false,
            });

            // Make backend request
            await API.deleteStream(streamToDelete);

            // Update success notification
            notifications.update({
                id: `delete-stream-${streamToDelete}`,
                title: 'Stream Deleted',
                message: streamUsageInfo?.channels_to_delete_count > 0
                    ? `Stream deleted. ${streamUsageInfo.channels_to_delete_count} channel(s) also deleted.`
                    : streamUsageInfo?.channel_count > 0
                        ? `Stream deleted and removed from ${streamUsageInfo.channel_count} channel(s)`
                        : 'Stream deleted successfully',
                color: 'green',
                loading: false,
                autoClose: 3000,
            });

        } catch (error) {
            console.error('[StreamLibrary] Failed to delete stream:', error);

            // ROLLBACK: Re-add stream to local DB
            if (deletedStreamData) {
                try {
                    await db.streams.add(deletedStreamData);
                    await loadLocalGroups();
                } catch (rollbackError) {
                    console.error('[StreamLibrary] Failed to rollback stream deletion:', rollbackError);
                }
            }

            notifications.update({
                id: `delete-stream-${streamToDelete}`,
                title: 'Error',
                message: 'Failed to delete stream. Changes have been reverted.',
                color: 'red',
                loading: false,
                autoClose: 5000,
            });
        } finally {
            setStreamToDelete(null);
            setStreamUsageInfo(null);
        }
    };

    const totalPages = Math.ceil(totalGroups / GROUPS_PER_PAGE);

    return (
        <Box h="100%" display="flex" style={{ flexDirection: 'column', position: 'relative' }}>
            {/* Cancel Drop Zone Overlay */}
            {isDraggingStream && (
                <Box
                    ref={setCancelRef}
                    style={{
                        position: 'absolute',
                        inset: 0,
                        zIndex: 1000,
                        backgroundColor: isCancelOver
                            ? 'rgba(230, 73, 73, 0.15)'
                            : 'rgba(0, 0, 0, 0.4)',
                        backdropFilter: 'blur(4px)',
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        justifyContent: 'center',
                        transition: 'all 0.2s ease',
                        border: isCancelOver
                            ? '3px dashed var(--mantine-color-red-6)'
                            : '3px dashed rgba(255, 255, 255, 0.2)',
                        borderRadius: 8,
                        pointerEvents: 'auto',
                    }}
                >
                    <Box
                        style={{
                            width: 80,
                            height: 80,
                            borderRadius: '50%',
                            backgroundColor: isCancelOver
                                ? 'var(--mantine-color-red-6)'
                                : 'rgba(255, 255, 255, 0.1)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            marginBottom: 16,
                            transition: 'all 0.2s ease',
                            boxShadow: isCancelOver
                                ? '0 8px 32px rgba(230, 73, 73, 0.4)'
                                : 'none',
                        }}
                    >
                        <IconX
                            size={40}
                            color={isCancelOver ? 'white' : 'rgba(255, 255, 255, 0.6)'}
                            style={{ transition: 'color 0.2s ease' }}
                        />
                    </Box>
                    <Text
                        size="xl"
                        fw={700}
                        c={isCancelOver ? 'red.4' : 'gray.4'}
                        style={{
                            transition: 'color 0.2s ease',
                            textTransform: 'uppercase',
                            letterSpacing: '1px',
                        }}
                    >
                        Drop to Cancel
                    </Text>
                    <Text
                        size="sm"
                        c="dimmed"
                        mt={4}
                    >
                        Release here to cancel the drag
                    </Text>
                </Box>
            )}

            <Box
                p="sm"
                style={{ borderBottom: '1px solid var(--mantine-color-dark-4)' }}
            >
                <Stack gap="xs">
                    <Group justify="space-between">
                        <Text fw={600} size="md">
                            Stream Library
                        </Text>
                        <ActionIcon
                            size="sm"
                            variant="subtle"
                            loading={syncing}
                            onClick={performSync}
                            title="Sync streams to local DB"
                        >
                            <IconRefresh size={14} />
                        </ActionIcon>
                    </Group>
                    {syncing && (
                        <Box>
                            <Text size="xs" c="dimmed" mb={2}>Syncing streams: {syncProgress}%</Text>
                            <Progress value={syncProgress} size="xs" animated />
                        </Box>
                    )}
                    <LibrarySearch
                        initialValue={debouncedSearch}
                        onSearchChange={setDebouncedSearch}
                    />
                    <Select
                        placeholder="All Sources"
                        data={(playlists || []).map(p => ({ value: String(p.id), label: p.name || `Source ${p.id}` }))}
                        value={selectedSource}
                        onChange={(val) => {
                            setSelectedSource(val);
                            setPage(1);
                        }}
                        size="xs"
                        clearable
                    />
                    <Select
                        placeholder="Filter by usage"
                        value={usageFilter}
                        onChange={(val) => {
                            setUsageFilter(val);
                            setPage(1);
                        }}
                        size="xs"
                        data={[
                            { label: 'Hide: None', value: 'none' },
                            { label: 'Hide: Used in any profile', value: 'hide-any' },
                            ...Object.values(profiles)
                                .filter(p => p.id !== '0') // Exclude the "All" profile
                                .map(p => ({
                                    label: `Hide: Used in ${p.name}`,
                                    value: `hide-profile-${p.id}`
                                }))
                        ]}
                    />
                </Stack>
            </Box>

            <ScrollArea style={{ flex: 1 }} scrollbarSize={6}>
                <Box p="xs">
                    {streamsByGroup.length > 0 ? (
                        <>
                            {streamsByGroup.map(([groupName, streams]) => (
                                <StreamGroup
                                    key={groupName}
                                    groupName={groupName}
                                    streams={streams}
                                    defaultOpen={streamsByGroup.length === 1 || debouncedSearch.length > 0}
                                    onDeleteStream={handleDeleteStream}
                                    disabled={!selectedGroup}
                                />
                            ))}
                            {totalPages > 1 && (
                                <Box py="md">
                                    <Pagination
                                        total={totalPages}
                                        value={page}
                                        onChange={setPage}
                                        size="xs"
                                        siblings={1}
                                        boundaries={0}
                                        justify="center"
                                    />
                                </Box>
                            )}
                        </>
                    ) : (
                        <Box p="md" style={{ textAlign: 'center' }}>
                            <Text c="dimmed" size="sm">
                                {loading ? 'Loading streams...' : syncing ? 'Syncing...' : 'No streams found'}
                            </Text>
                            {!syncing && streamsByGroup.length === 0 && (
                                <Button variant="subtle" size="xs" mt="sm" onClick={performSync}>
                                    Force Sync
                                </Button>
                            )}
                        </Box>
                    )}
                </Box>
            </ScrollArea>

            {/* Delete Confirmation Modal */}
            <Modal
                opened={deleteModalOpen}
                onClose={() => {
                    setDeleteModalOpen(false);
                    setStreamToDelete(null);
                    setStreamUsageInfo(null);
                }}
                title="Delete Stream"
                centered
            >
                <Stack gap="md">
                    {deleteCheckLoading ? (
                        <Center p="xl">
                            <Loader size="sm" />
                        </Center>
                    ) : (
                        <>
                            {streamUsageInfo && streamUsageInfo.channel_count > 0 ? (
                                <>
                                    <Text size="sm">
                                        This stream is currently used in <strong>{streamUsageInfo.channel_count}</strong> channel(s):
                                    </Text>
                                    <ScrollArea style={{ maxHeight: 200 }}>
                                        <Stack gap="xs">
                                            {streamUsageInfo.channels.map((channel) => (
                                                <Text key={channel.id} size="xs" c="dimmed">
                                                    • {channel.channel_number ? `#${channel.channel_number} - ` : ''}{channel.name}
                                                </Text>
                                            ))}
                                            {streamUsageInfo.channel_count > 10 && (
                                                <Text size="xs" c="dimmed" fs="italic">
                                                    ... and {streamUsageInfo.channel_count - 10} more
                                                </Text>
                                            )}
                                        </Stack>
                                    </ScrollArea>

                                    {streamUsageInfo.channels_to_delete_count > 0 ? (
                                        <>
                                            <Text size="sm" c="red" fw={600}>
                                                ⚠️ {streamUsageInfo.channels_to_delete_count} channel(s) will be DELETED
                                            </Text>
                                            <Text size="xs" c="dimmed">
                                                The following channels only have this stream and will be permanently deleted:
                                            </Text>
                                            <ScrollArea style={{ maxHeight: 150 }}>
                                                <Stack gap="xs">
                                                    {streamUsageInfo.channels_to_delete.map((channel) => (
                                                        <Text key={channel.id} size="xs" c="red">
                                                            • {channel.channel_number ? `#${channel.channel_number} - ` : ''}{channel.name}
                                                        </Text>
                                                    ))}
                                                    {streamUsageInfo.channels_to_delete_count > 10 && (
                                                        <Text size="xs" c="red" fs="italic">
                                                            ... and {streamUsageInfo.channels_to_delete_count - 10} more
                                                        </Text>
                                                    )}
                                                </Stack>
                                            </ScrollArea>
                                        </>
                                    ) : (
                                        <Text size="sm" c="orange">
                                            The stream will be removed from these channels (channels will remain).
                                        </Text>
                                    )}
                                </>
                            ) : (
                                <Text size="sm">
                                    Are you sure you want to delete this stream?
                                </Text>
                            )}

                            <Group justify="flex-end" mt="md">
                                <Button
                                    variant="subtle"
                                    onClick={() => {
                                        setDeleteModalOpen(false);
                                        setStreamToDelete(null);
                                        setStreamUsageInfo(null);
                                    }}
                                >
                                    Cancel
                                </Button>
                                <Button
                                    color="red"
                                    onClick={confirmDeleteStream}
                                >
                                    Delete Stream{streamUsageInfo?.channels_to_delete_count > 0 ? ` & ${streamUsageInfo.channels_to_delete_count} Channel(s)` : ''}
                                </Button>
                            </Group>
                        </>
                    )}
                </Stack>
            </Modal>
        </Box>
    );
};

export default StreamLibraryPanel;
