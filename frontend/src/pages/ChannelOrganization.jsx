import React, { useState, useCallback, useRef, useEffect } from 'react';
import {
    Box,
    Group,
    Text,
    Popover,
    TextInput,
    Button,
    Stack,
    ActionIcon,
    Switch,
    Select,
    NumberInput,
    Flex,
    useMantineTheme
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { Allotment } from 'allotment';
import { DndContext, DragOverlay, closestCenter, MouseSensor, TouchSensor, useSensor, useSensors } from '@dnd-kit/core';
import { arrayMove } from '@dnd-kit/sortable';
import GroupsExplorerPanel from '../components/channel-organization/GroupsExplorerPanel';
import { IconFolder, IconGripVertical } from '@tabler/icons-react';
import { Tv2, ScreenShare, Scroll, User, Copy } from 'lucide-react';
import GroupChannelsPanel from '../components/channel-organization/GroupChannelsPanel';
import StreamLibraryPanel from '../components/channel-organization/StreamLibraryPanel';
import ErrorBoundary from '../components/ErrorBoundary';
import EPGMatchModal from '../components/modals/EPGMatchModal';
import useChannelsStore from '../store/channels';
import useSettingsStore from '../store/settings';
import useAuthStore from '../store/auth';
import useLocalStorage from '../hooks/useLocalStorage';
import API from '../api';
import { copyToClipboard } from '../utils';
import '../components/channel-organization/channel-organization.css';

const STORAGE_KEY = 'channel-org-splitter-sizes';

const m3uUrlBase = `${window.location.protocol}//${window.location.host}/output/m3u`;
const epgUrlBase = `${window.location.protocol}//${window.location.host}/output/epg`;
const hdhrUrlBase = `${window.location.protocol}//${window.location.host}/hdhr`;

const getInitialSizes = () => {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        return stored ? JSON.parse(stored) : [22, 48, 30];
    } catch {
        return [22, 48, 30];
    }
};

const PageContent = () => {
    const [selectedGroup, setSelectedGroup] = useState(null);
    const [activeId, setActiveId] = useState(null);
    const [activeDragData, setActiveDragData] = useState(null);

    // EPG Match modal state
    const [epgMatchModalOpen, setEpgMatchModalOpen] = useState(false);
    const [epgMatchState, setEpgMatchState] = useState({
        channelIds: [],
        channelGroup: null,
        profileId: null,
        scopeLabel: null,
    });

    const theme = useMantineTheme();
    const env_mode = useSettingsStore((s) => s.environment.env_mode);
    const selectedProfileId = useChannelsStore((s) => s.selectedProfileId);
    const profiles = useChannelsStore((s) => s.profiles);

    const [hdhrUrl, setHDHRUrl] = useState(hdhrUrlBase);
    const [epgUrl, setEPGUrl] = useState(epgUrlBase);
    const [m3uUrl, setM3UUrl] = useState(m3uUrlBase);
    const [xcHost, setXCHost] = useState('');

    const [m3uParams, setM3uParams] = useLocalStorage(
        'channels-table-m3u-params',
        {
            cachedlogos: true,
            direct: false,
            tvg_id_source: 'channel_number',
        }
    );
    const [epgParams, setEpgParams] = useLocalStorage(
        'channels-table-epg-params',
        {
            cachedlogos: true,
            tvg_id_source: 'channel_number',
            days: 0,
        }
    );

    useEffect(() => {
        const profileString =
            selectedProfileId !== '0' ? `/${profiles[selectedProfileId]?.name || ''}` : '';
        setHDHRUrl(`${hdhrUrlBase}${profileString}`);
        setEPGUrl(`${epgUrlBase}${profileString}`);
        setM3UUrl(`${m3uUrlBase}${profileString}`);

        const baseHost = env_mode === 'dev' ? `${window.location.protocol}//${window.location.hostname}:5656` : `${window.location.protocol}//${window.location.host}`;
        setXCHost(baseHost);
    }, [selectedProfileId, profiles, env_mode]);

    const buildM3UUrl = () => {
        const params = new URLSearchParams();
        if (!m3uParams.cachedlogos) params.append('cachedlogos', 'false');
        if (m3uParams.direct) params.append('direct', 'true');
        if (m3uParams.tvg_id_source !== 'channel_number')
            params.append('tvg_id_source', m3uParams.tvg_id_source);

        const baseUrl = m3uUrl;
        return params.toString() ? `${baseUrl}?${params.toString()}` : baseUrl;
    };

    const buildEPGUrl = () => {
        const params = new URLSearchParams();
        if (!epgParams.cachedlogos) params.append('cachedlogos', 'false');
        if (epgParams.tvg_id_source !== 'channel_number')
            params.append('tvg_id_source', epgParams.tvg_id_source);
        if (epgParams.days > 0) params.append('days', epgParams.days.toString());

        const baseUrl = epgUrl;
        return params.toString() ? `${baseUrl}?${params.toString()}` : baseUrl;
    };

    const copyM3UUrl = async () => {
        await copyToClipboard(buildM3UUrl(), {
            successTitle: 'M3U URL Copied!',
            successMessage: 'The M3U URL has been copied to your clipboard.',
        });
    };

    const copyEPGUrl = async () => {
        await copyToClipboard(buildEPGUrl(), {
            successTitle: 'EPG URL Copied!',
            successMessage: 'The EPG URL has been copied to your clipboard.',
        });
    };

    const copyHDHRUrl = async () => {
        await copyToClipboard(hdhrUrl, {
            successTitle: 'HDHR URL Copied!',
            successMessage: 'The HDHR URL has been copied to your clipboard.',
        });
    };

    const stopPropagation = useCallback((e) => {
        e.stopPropagation();
    }, []);

    const handleMatchEpg = useCallback((channelIds = [], options = {}) => {
        setEpgMatchState({
            channelIds,
            channelGroup: options.channelGroup || null,
            profileId: options.profileId || null,
            scopeLabel: options.scopeLabel || null,
        });
        setEpgMatchModalOpen(true);
    }, []);

    const setSelectedProfileId = useChannelsStore((s) => s.setSelectedProfileId);

    const handleEpgMatchSuccess = useCallback(() => {
        console.log('[ChannelOrg] EPG match completed, refreshing channels');
        console.log('[ChannelOrg] refreshChannelsRef.current exists?', !!refreshChannelsRef.current);
        // Refresh the channel list to show updated EPG assignments
        if (refreshChannelsRef.current) {
            console.log('[ChannelOrg] Calling refreshChannelsRef.current()');
            refreshChannelsRef.current();
        } else {
            console.warn('[ChannelOrg] refreshChannelsRef.current is not set!');
        }
    }, []);

    // Use a ref to track sizes without causing re-renders during drag
    const sizesRef = useRef(getInitialSizes());

    const handleSplitterChange = useCallback((sizes) => {
        sizesRef.current = sizes;
    }, []);

    const handleSplitterDragEnd = useCallback(() => {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(sizesRef.current));
        } catch (e) {
            // ignore
        }
    }, []);

    const handleDragStart = useCallback((event) => {
        console.log('[DnD] handleDragStart', event.active.id, event.active.data.current);
        setActiveId(event.active.id);
        setActiveDragData(event.active.data.current);
    }, []);

    // Callback ref pattern: GroupChannelsPanel sets this so we can trigger refresh
    const refreshChannelsRef = useRef(null);
    // Callback ref for optimistic updates: GroupChannelsPanel sets this to update UI immediately
    const optimisticReorderRef = useRef(null);

    const handleDragEnd = useCallback(
        async (event) => {
            const { active, over } = event;
            if (!over || !active) return;

            const activeType = active.data.current?.type;
            const overType = over.data.current?.type;

            setActiveId(null);
            setActiveDragData(null);

            // --- Handle Cancel Drop ---
            if (overType === 'cancel') {
                console.log('[DnD] Drag cancelled by user');
                return; // Just cancel, no action needed
            }

            // --- Handle Group Drag (Reorder or Move between profiles) ---
            if (activeType === 'group') {
                const group = active.data.current.group;
                const sourceProfileId = active.data.current.profileId;
                const overData = over.data.current;

                let targetProfileId = null;
                let targetGroupId = null;

                if (overType === 'group') {
                    targetProfileId = overData.profileId;
                    targetGroupId = overData.group.id;
                } else if (overType === 'profile-header') {
                    targetProfileId = overData.profileId;
                }

                if (!targetProfileId) return;

                console.log(`[DnD] Moving group ${group.id} from profile ${sourceProfileId} to profile ${targetProfileId}`);

                try {
                    const fetchChannelProfiles = useChannelsStore.getState().fetchChannelProfiles;

                    if (sourceProfileId !== targetProfileId) {
                        // MOVE BETWEEN PROFILES
                        await API.removeProfileGroup(sourceProfileId, group.id);
                        await API.addProfileGroup(targetProfileId, { channel_group_id: group.id });
                    }

                    // REORDER within target profile
                    const updatedProfiles = await API.getChannelProfiles();
                    if (!Array.isArray(updatedProfiles)) return;
                    const targetProfile = updatedProfiles.find(p => String(p.id) === String(targetProfileId));

                    if (targetProfile && targetProfile.profile_groups) {
                        let groupIds = targetProfile.profile_groups
                            .sort((a, b) => {
                                const orderA = a.order ?? 999;
                                const orderB = b.order ?? 999;
                                if (orderA !== orderB) return orderA - orderB;
                                return (a.channel_group_name || '').localeCompare(b.channel_group_name || '');
                            })
                            .map(pg => pg.channel_group_id);

                        // If we are reordering relative to a target group
                        if (overType === 'group' && targetGroupId && targetGroupId !== group.id) {
                            groupIds = groupIds.filter(id => id !== group.id);
                            const targetIndex = groupIds.indexOf(targetGroupId);
                            groupIds.splice(targetIndex, 0, group.id);
                            await API.reorderProfileGroups(targetProfileId, groupIds);
                        }
                    }

                    await fetchChannelProfiles();
                } catch (error) {
                    console.error('Failed to move/reorder group:', error);
                }
            }

            // --- Handle Channel Reordering (Manual Sort) ---
            if (activeType === 'channel' && selectedGroup) {
                const liveGroup = useChannelsStore.getState().channelGroups[selectedGroup.id] || selectedGroup;
                const activeId = active.data.current.channel.id;
                const overIdStr = over.id.toString();
                const overId = parseInt(overIdStr.replace('channel-', ''));

                console.log(`[DnD] Channel reordering: ${activeId} -> ${overId}, sort_mode: ${liveGroup.sort_mode}`);
                console.log(`[DnD] Condition check: overId=${overId}, activeId=${activeId}, equal=${activeId === overId}, sortMode=${liveGroup.sort_mode}`);

                if (overId && activeId !== overId && liveGroup.sort_mode === 'manual') {
                    try {
                        const selectedProfileId = useChannelsStore.getState().selectedProfileId;
                        console.log(`[DnD] Fetching channel IDs for group "${selectedGroup.name}", profile: ${selectedProfileId}`);
                        const channelIds = await API.getGroupChannelIds(selectedGroup.name, selectedProfileId);
                        console.log(`[DnD] Fetched ${channelIds.length} channel IDs:`, channelIds);

                        const oldIndex = channelIds.indexOf(activeId);
                        const newIndex = channelIds.indexOf(overId);
                        console.log(`[DnD] Indices: oldIndex=${oldIndex}, newIndex=${newIndex}`);

                        if (oldIndex !== -1 && newIndex !== -1) {
                            const newOrder = arrayMove(channelIds, oldIndex, newIndex);

                            // Optimistically update the UI immediately
                            console.log('[DnD] Applying optimistic update');
                            if (optimisticReorderRef.current) {
                                optimisticReorderRef.current(activeId, overId);
                            }

                            // Save to backend
                            console.log('[DnD] Saving new channel order:', newOrder);
                            await API.reorderGroupChannels(selectedGroup.id, newOrder);

                            // Refresh stores in the background (no need to refresh channels since we already updated optimistically)
                            await useChannelsStore.getState().fetchChannelGroups();
                            await useChannelsStore.getState().fetchChannelProfiles();

                            console.log('[DnD] Reorder saved successfully');
                        } else {
                            console.warn(`[DnD] Cannot reorder: channel IDs not found in list. activeId=${activeId}, overId=${overId}`);
                        }
                    } catch (error) {
                        console.error('Failed to reorder channels:', error);
                        // Revert the optimistic update by refreshing from backend
                        console.log('[DnD] Reverting optimistic update due to error');
                        refreshChannelsRef.current?.();
                    }
                } else {
                    console.log(`[DnD] Skipping reorder: condition not met`);
                }
            }

            // --- Handle Stream or Multi-Stream Drag ---
            if (activeType === 'stream' || activeType === 'stream-group') {
                const isBulk = activeType === 'stream-group';
                const streamIds = isBulk ? (active.data.current?.streamIds || []) : (active.data.current?.streamId ? [active.data.current.streamId] : []);

                if (streamIds.length === 0) return;

                const overData = over.data.current;
                const overType = overData?.type;

                // Determine target group: either the group dropped on, or the currently selected group
                const targetGroup = overType === 'group' ? overData.group : selectedGroup;
                if (!targetGroup) {
                    console.log('[DnD] No target group for stream drop, ignoring');
                    return;
                }

                // Get live group data from store if possible
                const liveGroup = useChannelsStore.getState().channelGroups[targetGroup.id] || targetGroup;

                console.log(`[DnD] Processing ${activeType} drop onto:`, overType || over.id);

                if (overType === 'channel' && !isBulk) {
                    // ADD SINGLE STREAM TO EXISTING CHANNEL
                    const streamId = streamIds[0];
                    const channel = overData.channel;
                    if (!channel) return;

                    const currentStreamIds = (channel.streams || []).map(s => typeof s === 'object' ? s.id : s);

                    if (currentStreamIds.includes(streamId)) {
                        console.log('[DnD] Stream already in channel, skipping');
                        return;
                    }

                    try {
                        await API.updateChannel({
                            id: channel.id,
                            streams: [...currentStreamIds, streamId]
                        });
                        refreshChannelsRef.current?.();
                    } catch (error) {
                        console.error('Failed to add stream to channel:', error);
                    }
                } else if (overType === 'channel' && isBulk) {
                    // Bulk streams dropped on channel - currently not supported via UI badge but handle safely
                    console.log('[DnD] Bulk streams dropped on channel, ignoring');
                } else if (overType === 'gap' || over.id === 'channel-drop-zone' || overType === 'group') {
                    // CREATE NEW CHANNELS
                    const gapBeforeId = overData?.beforeId ?? null;

                    console.log(`[DnD] Creating channel(s) from ${activeType} in group ${targetGroup.name}`);
                    try {
                        if (isBulk) {
                            await API.createChannelsFromStreamsAsync(streamIds, null, null, targetGroup.id);
                        } else {
                            const result = await API.createChannelFromStream({
                                stream_id: streamIds[0],
                                channel_group_id: targetGroup.id,
                            });

                            // If we dropped into a specific gap and are in manual sort mode,
                            // we need to reorder to put the new channel at the drop position
                            if (result?.id && liveGroup.sort_mode === 'manual' && gapBeforeId != null) {
                                try {
                                    // Fetch current channel IDs in order for this group
                                    const selectedProfileId = useChannelsStore.getState().selectedProfileId;
                                    const channelIds = await API.getGroupChannelIds(targetGroup.name, selectedProfileId);

                                    // Remove the new channel from its current position (usually at end)
                                    const newId = result.id;
                                    const orderedIds = channelIds.filter(id => id !== newId);

                                    // Find insertion index
                                    const insertIdx = orderedIds.indexOf(gapBeforeId);
                                    if (insertIdx !== -1) {
                                        orderedIds.splice(insertIdx, 0, newId);
                                        await API.reorderGroupChannels(targetGroup.id, orderedIds);
                                    }
                                } catch (reorderError) {
                                    console.error('Failed to reorder new channel:', reorderError);
                                }
                            }
                        }

                        // Refresh store counts and UI
                        await useChannelsStore.getState().fetchChannelProfiles();
                        await useChannelsStore.getState().fetchChannelGroups();

                        if (targetGroup.id === selectedGroup?.id) {
                            refreshChannelsRef.current?.();
                        }
                    } catch (error) {
                        console.error('Failed to create channel(s) from stream(s):', error);
                        notifications.show({
                            title: 'Error',
                            message: 'Failed to create channel from stream',
                            color: 'red'
                        });
                    }
                }
            }
        },
        [selectedGroup]
    );

    const mouseSensor = useSensor(MouseSensor, {
        activationConstraint: { distance: 5 },
    });
    const touchSensor = useSensor(TouchSensor, {
        activationConstraint: { delay: 250, tolerance: 5 },
    });
    const sensors = useSensors(mouseSensor, touchSensor);

    return (
        <>
            <DndContext
                sensors={sensors}
                onDragStart={handleDragStart}
                onDragEnd={handleDragEnd}
                collisionDetection={closestCenter}
            >
                <Box h="100vh" w="100%" display="flex" style={{ flexDirection: 'column', overflow: 'hidden' }}>
                    {/* Top Toolbar */}
                    <Box
                        px="md"
                        py={8}
                        style={{
                            borderBottom: '1px solid var(--mantine-color-dark-4)',
                            backgroundColor: '#1f1f23',
                            flexShrink: 0,
                        }}
                    >
                        <Group justify="space-between">
                            <Text
                                fw={500}
                                size="lg"
                                style={{
                                    letterSpacing: '-0.3px',
                                    color: 'var(--mantine-color-gray-4)',
                                }}
                            >
                                Channel Organizer
                            </Text>

                            <Flex style={{ alignItems: 'center' }} gap="md">
                                <Text
                                    style={{
                                        fontFamily: 'Inter, sans-serif',
                                        fontWeight: 400,
                                        fontSize: '14px',
                                        lineHeight: 1,
                                        letterSpacing: '-0.3px',
                                        color: 'var(--mantine-color-gray-6)',
                                        marginRight: 0,
                                    }}
                                >
                                    Links:
                                </Text>
                                <Group gap={5}>
                                    <Popover withArrow shadow="md" zIndex={1000} position="bottom-start" withinPortal>
                                        <Popover.Target>
                                            <Button
                                                leftSection={<Tv2 size={18} />}
                                                size="compact-xs"
                                                variant="subtle"
                                                style={{
                                                    borderColor: theme.palette.custom.greenMain,
                                                    color: theme.palette.custom.greenMain,
                                                }}
                                            >
                                                HDHR
                                            </Button>
                                        </Popover.Target>
                                        <Popover.Dropdown>
                                            <Group gap="sm" style={{ minWidth: 250, width: 'max-content' }}>
                                                <TextInput value={hdhrUrl} size="xs" readOnly style={{ flex: 1 }} />
                                                <ActionIcon onClick={copyHDHRUrl} size="sm" variant="transparent" color="gray.5">
                                                    <Copy size="16" />
                                                </ActionIcon>
                                            </Group>
                                        </Popover.Dropdown>
                                    </Popover>

                                    <Popover withArrow shadow="md" zIndex={1000} position="bottom-start" withinPortal>
                                        <Popover.Target>
                                            <Button
                                                leftSection={<ScreenShare size={18} />}
                                                size="compact-xs"
                                                variant="subtle"
                                                style={{
                                                    borderColor: theme.palette.custom.indigoMain,
                                                    color: theme.palette.custom.indigoMain,
                                                }}
                                            >
                                                M3U
                                            </Button>
                                        </Popover.Target>
                                        <Popover.Dropdown>
                                            <Stack gap="sm" style={{ minWidth: 300 }} onClick={stopPropagation} onMouseDown={stopPropagation}>
                                                <TextInput
                                                    value={buildM3UUrl()}
                                                    size="xs"
                                                    readOnly
                                                    label="Generated URL"
                                                    rightSection={
                                                        <ActionIcon onClick={copyM3UUrl} size="sm" variant="transparent" color="gray.5">
                                                            <Copy size="16" />
                                                        </ActionIcon>
                                                    }
                                                />
                                                <Group justify="space-between">
                                                    <Text size="sm">Use cached logos</Text>
                                                    <Switch
                                                        size="sm"
                                                        checked={m3uParams.cachedlogos}
                                                        onChange={(event) => setM3uParams(prev => ({ ...prev, cachedlogos: event.target.checked }))}
                                                    />
                                                </Group>
                                                <Group justify="space-between">
                                                    <Text size="sm">Direct stream URLs</Text>
                                                    <Switch
                                                        size="sm"
                                                        checked={m3uParams.direct}
                                                        onChange={(event) => setM3uParams(prev => ({ ...prev, direct: event.target.checked }))}
                                                    />
                                                </Group>
                                                <Select
                                                    label="TVG-ID Source"
                                                    size="xs"
                                                    value={m3uParams.tvg_id_source}
                                                    onChange={(v) => setM3uParams(prev => ({ ...prev, tvg_id_source: v }))}
                                                    data={['channel_number', 'tvg_id', 'gracenote']}
                                                />
                                            </Stack>
                                        </Popover.Dropdown>
                                    </Popover>

                                    <Popover withArrow shadow="md" zIndex={1000} position="bottom-start" withinPortal>
                                        <Popover.Target>
                                            <Button
                                                leftSection={<Scroll size={18} />}
                                                size="compact-xs"
                                                variant="subtle"
                                                style={{
                                                    borderColor: theme.palette.custom.greyBorder,
                                                    color: theme.palette.custom.greyBorder,
                                                }}
                                            >
                                                EPG
                                            </Button>
                                        </Popover.Target>
                                        <Popover.Dropdown>
                                            <Stack gap="sm" style={{ minWidth: 300 }} onClick={stopPropagation} onMouseDown={stopPropagation}>
                                                <TextInput
                                                    value={buildEPGUrl()}
                                                    size="xs"
                                                    readOnly
                                                    label="Generated URL"
                                                    rightSection={
                                                        <ActionIcon onClick={copyEPGUrl} size="sm" variant="transparent" color="gray.5">
                                                            <Copy size="16" />
                                                        </ActionIcon>
                                                    }
                                                />
                                                <Group justify="space-between">
                                                    <Text size="sm">Use cached logos</Text>
                                                    <Switch
                                                        size="sm"
                                                        checked={epgParams.cachedlogos}
                                                        onChange={(event) => setEpgParams(prev => ({ ...prev, cachedlogos: event.target.checked }))}
                                                    />
                                                </Group>
                                                <Select
                                                    label="TVG-ID Source"
                                                    size="xs"
                                                    value={epgParams.tvg_id_source}
                                                    onChange={(v) => setEpgParams(prev => ({ ...prev, tvg_id_source: v }))}
                                                    data={['channel_number', 'tvg_id', 'gracenote']}
                                                />
                                                <NumberInput
                                                    label="Days (0 = all data)"
                                                    size="xs"
                                                    min={0}
                                                    value={epgParams.days}
                                                    onChange={(v) => setEpgParams(prev => ({ ...prev, days: v || 0 }))}
                                                />
                                            </Stack>
                                        </Popover.Dropdown>
                                    </Popover>

                                    <Popover withArrow shadow="md" zIndex={1000} position="bottom-start" withinPortal>
                                        <Popover.Target>
                                            <Button
                                                leftSection={<User size={18} />}
                                                size="compact-xs"
                                                variant="subtle"
                                                style={{
                                                    borderColor: theme.palette.secondary.main,
                                                    color: theme.palette.secondary.main,
                                                }}
                                            >
                                                XC
                                            </Button>
                                        </Popover.Target>
                                        <Popover.Dropdown>
                                            <Stack gap="sm" style={{ minWidth: 300 }} onClick={stopPropagation} onMouseDown={stopPropagation}>
                                                <TextInput
                                                    label="Host"
                                                    value={xcHost}
                                                    size="xs"
                                                    readOnly
                                                    rightSection={
                                                        <ActionIcon onClick={() => copyToClipboard(xcHost)} size="sm" variant="transparent" color="gray.5">
                                                            <Copy size="16" />
                                                        </ActionIcon>
                                                    }
                                                />
                                                <TextInput
                                                    label="Username"
                                                    value={useAuthStore.getState().user?.username || ''}
                                                    size="xs"
                                                    readOnly
                                                    rightSection={
                                                        <ActionIcon onClick={() => copyToClipboard(useAuthStore.getState().user?.username)} size="sm" variant="transparent" color="gray.5">
                                                            <Copy size="16" />
                                                        </ActionIcon>
                                                    }
                                                />
                                                <TextInput
                                                    label="Password"
                                                    value={useAuthStore.getState().user?.custom_properties?.xc_password || 'Not set'}
                                                    size="xs"
                                                    readOnly
                                                    rightSection={
                                                        <ActionIcon onClick={() => copyToClipboard(useAuthStore.getState().user?.custom_properties?.xc_password)} size="sm" variant="transparent" color="gray.5">
                                                            <Copy size="16" />
                                                        </ActionIcon>
                                                    }
                                                />
                                            </Stack>
                                        </Popover.Dropdown>
                                    </Popover>
                                </Group>
                            </Flex>
                        </Group>
                    </Box>

                    {/* Three-Panel Layout */}
                    <Box style={{ flex: 1, overflow: 'hidden' }}>
                        <Allotment
                            defaultSizes={sizesRef.current}
                            onChange={handleSplitterChange}
                            onDragEnd={handleSplitterDragEnd}
                        >
                            {/* Left Panel: Profiles & Groups Tree */}
                            <Allotment.Pane minSize={200} preferredSize={240}>
                                <Box h="100%" style={{ overflow: 'hidden' }}>
                                    <GroupsExplorerPanel
                                        selectedGroup={selectedGroup}
                                        onSelectGroup={setSelectedGroup}
                                        onMatchEpg={handleMatchEpg}
                                    />
                                </Box>
                            </Allotment.Pane>

                            {/* Middle Panel: Channels in Group */}
                            <Allotment.Pane minSize={300}>
                                <Box h="100%" style={{ overflow: 'hidden' }}>
                                    <GroupChannelsPanel
                                        selectedGroup={selectedGroup}
                                        onRefreshRef={refreshChannelsRef}
                                        onOptimisticReorderRef={optimisticReorderRef}
                                        onMatchEpg={handleMatchEpg}
                                    />
                                </Box>
                            </Allotment.Pane>

                            {/* Right Panel: Stream Library */}
                            <Allotment.Pane minSize={220} preferredSize={280}>
                                <Box h="100%" style={{ overflow: 'hidden' }}>
                                    <StreamLibraryPanel selectedGroup={selectedGroup} />
                                </Box>
                            </Allotment.Pane>
                        </Allotment>
                    </Box>
                </Box >

                <DragOverlay dropAnimation={null} zIndex={1000}>
                    {activeId && (activeDragData?.type === 'stream' || activeDragData?.type === 'stream-group') ? (
                        <Box
                            px="md"
                            py="xs"
                            style={{
                                background: 'var(--mantine-color-dark-7)',
                                border: '2px solid var(--mantine-color-blue-6)',
                                borderRadius: 'var(--mantine-radius-md)',
                                boxShadow: 'var(--mantine-shadow-xl)',
                                maxWidth: 350,
                                pointerEvents: 'none',
                                cursor: 'grabbing',
                            }}
                        >
                            <Group gap="xs" wrap="nowrap">
                                <Box
                                    w={4}
                                    h={20}
                                    style={{
                                        backgroundColor: 'var(--mantine-color-blue-6)',
                                        borderRadius: 2,
                                    }}
                                />
                                <Box style={{ flex: 1 }}>
                                    <Text size="xs" c="dimmed" fw={500} style={{ lineHeight: 1 }}>
                                        {activeDragData?.type === 'stream-group' ? `Import ${activeDragData.streamIds.length} streams from` : 'Create channel from'}
                                    </Text>
                                    <Text size="sm" fw={600} truncate style={{ lineHeight: 1.4 }}>
                                        {activeDragData?.type === 'stream-group' ? activeDragData.groupName : (activeDragData?.streamName || 'Selected Stream')}
                                    </Text>
                                </Box>
                            </Group>
                        </Box>
                    ) : activeId && activeDragData?.type === 'group' ? (
                        <Box
                            px="sm"
                            py={6}
                            style={{
                                background: 'var(--mantine-color-dark-6)',
                                border: '1px solid var(--mantine-color-blue-5)',
                                borderRadius: 6,
                                boxShadow: 'var(--mantine-shadow-lg)',
                                width: 200,
                                pointerEvents: 'none',
                                cursor: 'grabbing',
                                opacity: 0.9,
                            }}
                        >
                            <Group gap="xs" wrap="nowrap">
                                <IconGripVertical size={14} style={{ color: 'var(--mantine-color-gray-5)' }} />
                                <Box style={{ width: 16, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                    <IconFolder size={14} style={{ color: 'var(--mantine-color-gray-6)' }} />
                                </Box>
                                <Text size="xs" fw={500} truncate style={{ flex: 1 }}>
                                    {activeDragData.group.name}
                                </Text>
                            </Group>
                        </Box>
                    ) : null}
                </DragOverlay>
            </DndContext >

            <EPGMatchModal
                opened={epgMatchModalOpen}
                onClose={() => setEpgMatchModalOpen(false)}
                onSuccess={handleEpgMatchSuccess}
                selectedChannelIds={epgMatchState.channelIds}
                channelGroup={epgMatchState.channelGroup}
                profileId={epgMatchState.profileId}
                scopeLabel={epgMatchState.scopeLabel}
            />
        </>
    );
};

const ChannelOrganizationPage = () => {
    return (
        <ErrorBoundary>
            <PageContent />
        </ErrorBoundary>
    );
};

export default ChannelOrganizationPage;
