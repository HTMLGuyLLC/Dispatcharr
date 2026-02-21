import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useDroppable, useDndMonitor } from '@dnd-kit/core';
import { useDebounce, copyToClipboard } from '../../utils';
import {
    Box,
    TextInput,
    Button,
    Stack,
    Group,
    Text,
    ScrollArea,
    Table,
    ActionIcon,
    Select,
    NativeSelect,
    Menu,
    Badge,
    Tooltip,
    Modal,
    Collapse,
    Pagination,
    SegmentedControl,
    Checkbox,
    Transition,
    Switch,
    Image,
    Center,
    Loader,
} from '@mantine/core';
import { Dropzone } from '@mantine/dropzone';
import { Upload, FileImage, X as LucideX } from 'lucide-react';
import { notifications } from '@mantine/notifications';
import {
    SortableContext,
    verticalListSortingStrategy,
    useSortable
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
    IconSearch,
    IconPlus,
    IconHelp,
    IconDots,
    IconPlayerPlay,
    IconEdit,
    IconTrash,
    IconChevronRight,
    IconChevronDown,
    IconEye,
    IconEyeOff,
    IconArrowsSort,
    IconWand,
    IconGripVertical,
    IconTrashFilled,
    IconStack,
    IconCircleX,
    IconCopy,
    IconPhoto,
} from '@tabler/icons-react';
import useChannelsStore from '../../store/channels';
import usePlaylistsStore from '../../store/playlists';
import InlineAddPopover from './InlineAddPopover';
import useVideoStore from '../../store/useVideoStore';
import useSettingsStore from '../../store/settings';
import API from '../../api';
import ChannelForm from '../forms/Channel';
import ConfirmationDialog from '../ConfirmationDialog';

const DropGap = React.memo(({ index, beforeId, isStreamDragging }) => {
    const dropData = useMemo(() => ({
        type: 'gap',
        index,
        beforeId,
    }), [index, beforeId]);

    const { setNodeRef, isOver } = useDroppable({
        id: `gap - ${index} -${beforeId} `,
        data: dropData,
    });

    return (
        <Table.Tr ref={setNodeRef}>
            <Table.Td colSpan={5} p={0} style={{ position: 'relative', height: isOver ? 40 : 2, transition: 'height 0.2s ease' }}>
                {isOver && isStreamDragging && (
                    <Box
                        style={{
                            position: 'absolute',
                            inset: 0,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            backgroundColor: 'rgba(34, 139, 230, 0.15)',
                            border: '1px dashed var(--mantine-color-blue-6)',
                            borderRadius: 4,
                            zIndex: 1,
                        }}
                    >
                        <Text size="xs" fw={600} c="blue.6">Insert New Channel Here</Text>
                    </Box>
                )}
                {!isOver && (
                    <Box
                        style={{
                            height: 1,
                            width: '100%',
                            backgroundColor: isStreamDragging ? 'rgba(34, 139, 230, 0.1)' : 'transparent',
                            visibility: isStreamDragging ? 'visible' : 'hidden',
                        }}
                    />
                )}
            </Table.Td>
        </Table.Tr>
    );
});

const EndDropZone = React.memo(({ index, isStreamDragging }) => {
    const { setNodeRef, isOver } = useDroppable({
        id: 'gap-end',
        data: {
            type: 'gap',
            index,
            beforeId: null,
        },
    });

    return (
        <Box
            ref={setNodeRef}
            p="md"
            style={{
                borderTop: '1px solid var(--mantine-color-dark-4)',
                backgroundColor: 'var(--mantine-color-dark-7)',
                position: 'relative',
                zIndex: 10,
            }}
        >
            <Box
                style={{
                    height: 120,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    border: `2px dashed ${isOver ? 'var(--mantine-color-blue-6)' : 'var(--mantine-color-gray-7)'} `,
                    backgroundColor: isOver ? 'rgba(34, 139, 230, 0.1)' : 'transparent',
                    borderRadius: 8,
                    transition: 'all 0.2s ease',
                    cursor: 'default',
                }}
            >
                <IconPlus
                    size={24}
                    style={{
                        marginBottom: 4,
                        color: isOver ? 'var(--mantine-color-blue-6)' : 'var(--mantine-color-gray-6)',
                        transition: 'color 0.2s ease'
                    }}
                />
                <Text
                    size="sm"
                    fw={600}
                    c={isOver ? 'blue.6' : 'dimmed'}
                    style={{ transition: 'color 0.2s ease' }}
                >
                    Drop here to create new channel{isOver ? '(s)' : ''}
                </Text>
                <Text size="xs" c="dimmed" opacity={0.7}>
                    (Appends to end of group)
                </Text>
            </Box>
        </Box>
    );
});

/* ─── Image Upload Modal for Channels ─── */
const ChannelImageUploadModal = ({ opened, onClose, channel, onSuccess }) => {
    const [uploading, setUploading] = useState(false);
    const [selectedFile, setSelectedFile] = useState(null);
    const [preview, setPreview] = useState(null);

    useEffect(() => {
        if (!opened) {
            setSelectedFile(null);
            setPreview(null);
        }
    }, [opened]);

    const handleFileSelect = (files) => {
        if (files.length === 0) return;
        const file = files[0];

        if (file.size > 5 * 1024 * 1024) {
            notifications.show({
                title: 'Error',
                message: 'File too large. Maximum size is 5MB.',
                color: 'red',
            });
            return;
        }

        setSelectedFile(file);
        const previewUrl = URL.createObjectURL(file);
        setPreview(previewUrl);
    };

    const handleUpload = async () => {
        if (!selectedFile) return;

        setUploading(true);
        try {
            // Use the filename as the logo name, or generate one from channel name if empty
            // Sanitize filename to avoid URL encoding issues
            let logoName = selectedFile.name ? selectedFile.name.replace(/[^a-zA-Z0-9.]/g, '_') : '';
            if (!logoName.trim()) {
                const timestamp = Date.now();
                const extension = selectedFile.type.split('/')[1] || 'png';
                logoName = `${channel.name.replace(/[^a-zA-Z0-9]/g, '_')}_${timestamp}.${extension}`;
            }

            const uploadResponse = await API.uploadLogo(selectedFile, logoName);

            // Use 'logo_id' field (writable field that sources from 'logo')
            await API.updateChannel({ id: channel.id, logo_id: uploadResponse.id });

            notifications.show({
                title: 'Success',
                message: 'Channel logo updated successfully',
                color: 'green',
            });

            onSuccess?.();
            onClose();
        } catch (error) {
            console.error('Failed to upload logo:', error);
            notifications.show({
                title: 'Error',
                message: error?.body?.detail || error?.message || 'Failed to upload logo',
                color: 'red',
            });
        } finally {
            setUploading(false);
        }
    };

    const handleRemoveLogo = async () => {
        setUploading(true);
        try {
            // Use 'logo_id' field (writable field that sources from 'logo')
            await API.updateChannel({ id: channel.id, logo_id: null });

            notifications.show({
                title: 'Success',
                message: 'Channel logo removed',
                color: 'green',
            });

            onSuccess?.();
            onClose();
        } catch (error) {
            console.error('Failed to remove logo:', error);
            notifications.show({
                title: 'Error',
                message: error?.body?.detail || error?.message || 'Failed to remove logo',
                color: 'red',
            });
        } finally {
            setUploading(false);
        }
    };

    useEffect(() => {
        return () => {
            if (preview && preview.startsWith('blob:')) {
                URL.revokeObjectURL(preview);
            }
        };
    }, [preview]);

    const logoUrl = channel?.logo_cache_url || channel?.logo?.cache_url;

    return (
        <Modal
            opened={opened}
            onClose={onClose}
            title={logoUrl ? 'Change Channel Logo' : 'Set Channel Logo'}
            size="md"
        >
            <Stack spacing="md">
                {(preview || logoUrl) && (
                    <Center>
                        <Box>
                            <Text size="sm" color="dimmed" mb="xs" ta="center">
                                Preview
                            </Text>
                            <Image
                                src={preview || logoUrl}
                                alt="Channel logo preview"
                                width={100}
                                height={75}
                                fit="contain"
                            />
                        </Box>
                    </Center>
                )}

                <Dropzone
                    onDrop={handleFileSelect}
                    loading={uploading}
                    accept={{
                        'image/*': ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'],
                    }}
                    multiple={false}
                    maxSize={5 * 1024 * 1024}
                >
                    <Group justify="center" gap="xl" mih={120} style={{ pointerEvents: 'none' }}>
                        <Dropzone.Accept>
                            <Upload size={50} color="green" />
                        </Dropzone.Accept>
                        <Dropzone.Reject>
                            <LucideX size={50} color="red" />
                        </Dropzone.Reject>
                        <Dropzone.Idle>
                            <FileImage size={50} />
                        </Dropzone.Idle>

                        <div>
                            <Text size="xl" inline>
                                {selectedFile
                                    ? `Selected: ${selectedFile.name} `
                                    : 'Drag image here or click to select'}
                            </Text>
                            <Text size="sm" color="dimmed" inline mt={7}>
                                Supports PNG, JPEG, GIF, WebP, SVG files (max 5MB)
                            </Text>
                        </div>
                    </Group>
                </Dropzone>

                <Group justify="flex-end" mt="md">
                    {logoUrl && (
                        <Button
                            variant="light"
                            color="red"
                            onClick={handleRemoveLogo}
                            loading={uploading}
                        >
                            Remove Logo
                        </Button>
                    )}
                    <Button variant="light" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button
                        onClick={handleUpload}
                        loading={uploading}
                        disabled={!selectedFile}
                    >
                        Upload
                    </Button>
                </Group>
            </Stack>
        </Modal>
    );
};

/* ─── Image Preview Modal for Channels ─── */
const ChannelImagePreviewModal = ({ opened, onClose, imageUrl, channelName }) => {
    return (
        <Modal
            opened={opened}
            onClose={onClose}
            title={channelName}
            size="lg"
            centered
        >
            <Center>
                <Image
                    src={imageUrl}
                    alt={channelName}
                    fit="contain"
                    style={{ maxHeight: '70vh' }}
                />
            </Center>
        </Modal>
    );
};

const ChannelRowGroup = React.memo(({
    channel,
    onRefresh,
    onEdit,
    onDelete,
    onMatchEpg,
    isStreamDragging, // Any stream or group being dragged
    isSingleStreamDragging, // Only single streams (can be dropped on channels)
    isManualSort,
    isSelected,
    onToggleSelect
}) => {
    const [expanded, setExpanded] = useState(false);
    const [imageUploadModalOpen, setImageUploadModalOpen] = useState(false);
    const [imagePreviewModalOpen, setImagePreviewModalOpen] = useState(false);
    const [isDraggingImageOver, setIsDraggingImageOver] = useState(false);
    const [isEditingName, setIsEditingName] = useState(false);
    const [editNameValue, setEditNameValue] = useState(channel.name);
    const nameInputRef = useRef(null);
    const showVideo = useVideoStore((s) => s.showVideo);
    const env_mode = useSettingsStore((s) => s.environment.env_mode);

    const {
        attributes,
        listeners,
        setNodeRef,
        transform,
        transition,
        isDragging,
        isOver,
    } = useSortable({
        id: `channel - ${channel.id} `,
        data: {
            type: 'channel',
            channel,
        },
        disabled: !isManualSort && !isStreamDragging,
    });

    const style = {
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
        position: 'relative',
        zIndex: isDragging ? 100 : undefined,
    };

    const handleWatchStream = useCallback((stream) => {
        if (!stream) return;
        const streamHash = stream.stream_hash || stream.id;
        let vidUrl = `/proxy/ts/stream/${streamHash}`;
        if (env_mode === 'dev') {
            vidUrl = `${window.location.protocol}//${window.location.hostname}:5656${vidUrl}`;
        }
        showVideo(vidUrl);
    }, [showVideo, env_mode]);

    const handlePreviewChannel = () => {
        if (channel.streams && channel.streams.length > 0) {
            handleWatchStream(channel.streams[0]);
        }
    };

    const getChannelURL = useCallback(() => {
        if (!channel || !channel.uuid) {
            console.error('Invalid channel object or missing UUID:', channel);
            return '';
        }

        const uri = `/proxy/ts/stream/${channel.uuid}`;
        let channelUrl = `${window.location.protocol}//${window.location.host}${uri}`;
        if (env_mode === 'dev') {
            channelUrl = `${window.location.protocol}//${window.location.hostname}:5656${uri}`;
        }

        return channelUrl;
    }, [channel, env_mode]);

    const handleCopyURL = useCallback((e) => {
        e.stopPropagation();
        copyToClipboard(getChannelURL());
    }, [getChannelURL]);

    const handleEdit = (e) => {
        e.stopPropagation();
        onEdit(channel);
    };

    const handleDelete = (e) => {
        e.stopPropagation();
        onDelete(channel);
    };

    const handleDeleteStream = async (stream) => {
        try {
            const streamId = stream.id || stream;
            const newStreamIds = channel.streams
                .filter(s => {
                    const id = typeof s === 'object' ? s.id : s;
                    return id !== streamId;
                })
                .map(s => typeof s === 'object' ? s.id : s);

            await API.updateChannel({
                id: channel.id,
                streams: newStreamIds
            });
            onRefresh();
        } catch (error) {
            console.error('Failed to remove stream from channel:', error);
        }
    };

    const handleToggleHidden = async (e) => {
        e.stopPropagation();
        try {
            await API.updateChannel({
                id: channel.id,
                is_hidden: !channel.is_hidden
            });
            onRefresh();
        } catch (error) {
            console.error('Failed to toggle channel visibility:', error);
        }
    };

    // --- Double-click to rename ---
    useEffect(() => {
        if (isEditingName && nameInputRef.current) {
            nameInputRef.current.focus();
            nameInputRef.current.select();
        }
    }, [isEditingName]);

    const handleNameDoubleClick = useCallback((e) => {
        e.stopPropagation();
        setEditNameValue(channel.name);
        setIsEditingName(true);
    }, [channel.name]);

    const handleNameSave = useCallback(async () => {
        const trimmed = editNameValue.trim();
        if (trimmed && trimmed !== channel.name) {
            try {
                await API.updateChannel({ id: channel.id, name: trimmed });
                onRefresh();
            } catch (error) {
                console.error('Failed to rename channel:', error);
                setEditNameValue(channel.name);
            }
        }
        setIsEditingName(false);
    }, [editNameValue, channel, onRefresh]);

    const handleNameCancel = useCallback(() => {
        setEditNameValue(channel.name);
        setIsEditingName(false);
    }, [channel.name]);

    const handleNameKeyDown = useCallback((e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            handleNameSave();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            handleNameCancel();
        }
    }, [handleNameSave, handleNameCancel]);
    const handleDragOver = useCallback((e) => {
        e.preventDefault();
        e.stopPropagation();

        const hasImageFile = Array.from(e.dataTransfer.items).some(
            item => item.kind === 'file' && item.type.startsWith('image/')
        );

        if (hasImageFile) {
            setIsDraggingImageOver(true);
        }
    }, []);

    const handleDragLeave = useCallback((e) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDraggingImageOver(false);
    }, []);

    const handleDrop = useCallback(async (e) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDraggingImageOver(false);

        const files = Array.from(e.dataTransfer.files).filter(file =>
            file.type.startsWith('image/')
        );

        if (files.length === 0) return;

        const file = files[0];
        if (file.size > 5 * 1024 * 1024) {
            notifications.show({
                title: 'Error',
                message: 'File too large. Maximum size is 5MB.',
                color: 'red',
            });
            return;
        }

        try {
            // Use the filename as the logo name, or generate one from channel name if empty
            // Sanitize filename to avoid URL encoding issues
            let logoName = file.name ? file.name.replace(/[^a-zA-Z0-9.]/g, '_') : '';
            if (!logoName.trim()) {
                const timestamp = Date.now();
                const extension = file.type.split('/')[1] || 'png';
                logoName = `${channel.name.replace(/[^a-zA-Z0-9]/g, '_')}_${timestamp}.${extension}`;
            }

            const uploadResponse = await API.uploadLogo(file, logoName);

            // Use 'logo_id' field (writable field that sources from 'logo')
            await API.updateChannel({ id: channel.id, logo_id: uploadResponse.id });

            notifications.show({
                title: 'Success',
                message: 'Channel logo updated successfully',
                color: 'green',
            });

            onRefresh?.();
        } catch (error) {
            console.error('Failed to upload logo:', error);
            notifications.show({
                title: 'Error',
                message: error?.body?.detail || error?.message || 'Failed to upload logo',
                color: 'red',
            });
        }
    }, [channel, onRefresh]);

    const handleImageClick = useCallback((e) => {
        e.stopPropagation();
        const logoUrl = channel?.logo_cache_url || channel?.logo?.cache_url;
        if (logoUrl) {
            setImagePreviewModalOpen(true);
        }
    }, [channel]);

    const logoUrl = channel?.logo_cache_url || channel?.logo?.cache_url;

    return (
        <>
            <ChannelImageUploadModal
                opened={imageUploadModalOpen}
                onClose={() => setImageUploadModalOpen(false)}
                channel={channel}
                onSuccess={onRefresh}
            />

            <ChannelImagePreviewModal
                opened={imagePreviewModalOpen}
                onClose={() => setImagePreviewModalOpen(false)}
                imageUrl={logoUrl}
                channelName={channel.name}
            />

            <Table.Tbody
                ref={setNodeRef}
                style={{
                    ...style,
                    backgroundColor: isDraggingImageOver
                        ? 'rgba(34, 139, 230, 0.15)'
                        : (isOver && isSingleStreamDragging
                            ? 'rgba(34, 139, 230, 0.12)'
                            : (isSelected ? 'rgba(34, 139, 230, 0.06)' : undefined)),
                    outline: isDraggingImageOver ? '2px dashed var(--mantine-color-blue-6)' : 'none',
                    transition: 'background-color 0.15s ease, transform 0.2s cubic-bezier(0.2, 0, 0, 1)',
                }}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
            >
                <Table.Tr
                    style={{
                        borderLeft: isOver && isSingleStreamDragging ? '4px solid var(--mantine-color-blue-6)' : (isSelected ? '4px solid var(--mantine-color-blue-6)' : 'none'),
                        backgroundColor: 'transparent',
                        cursor: 'pointer',
                    }}
                    onDoubleClick={!isEditingName ? handlePreviewChannel : undefined}
                    onClick={() => !isEditingName && onToggleSelect(channel.id)}
                >
                    <Table.Td style={{ width: isManualSort ? 110 : 80 }}>
                        <Group gap={4} wrap="nowrap">
                            {isManualSort && (
                                <Box {...attributes} {...listeners} style={{ cursor: 'grab', display: 'flex' }} onClick={e => e.stopPropagation()}>
                                    <IconGripVertical size={16} color="var(--mantine-color-gray-6)" />
                                </Box>
                            )}
                            <ActionIcon
                                size="xs"
                                variant="subtle"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    setExpanded(!expanded);
                                }}
                                disabled={!channel.streams || channel.streams.length === 0}
                            >
                                {expanded ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
                            </ActionIcon>
                            <Text size="sm" c="dimmed" style={{ minWidth: 20 }}>
                                {channel.channel_number}
                            </Text>
                        </Group>
                    </Table.Td>
                    <Table.Td>
                        <Group justify="space-between" wrap="nowrap">
                            <Group gap="xs" wrap="nowrap">
                                {logoUrl ? (
                                    <Tooltip label="Click to enlarge" withArrow>
                                        <Box
                                            onClick={handleImageClick}
                                            style={{
                                                cursor: 'pointer',
                                                display: 'flex',
                                                alignItems: 'center',
                                                transition: 'transform 0.2s ease',
                                            }}
                                            onMouseEnter={(e) => {
                                                e.currentTarget.style.transform = 'scale(1.1)';
                                            }}
                                            onMouseLeave={(e) => {
                                                e.currentTarget.style.transform = 'scale(1)';
                                            }}
                                        >
                                            <Image
                                                src={logoUrl}
                                                w={24}
                                                h={24}
                                                fit="contain"
                                                radius="sm"
                                            />
                                        </Box>
                                    </Tooltip>
                                ) : null}
                                {isEditingName ? (
                                    <TextInput
                                        ref={nameInputRef}
                                        value={editNameValue}
                                        onChange={(e) => setEditNameValue(e.target.value)}
                                        onKeyDown={handleNameKeyDown}
                                        onBlur={handleNameSave}
                                        onClick={(e) => e.stopPropagation()}
                                        size="xs"
                                        style={{ flex: 1 }}
                                        styles={{
                                            input: {
                                                minHeight: 22,
                                                height: 22,
                                                fontSize: 'var(--mantine-font-size-sm)',
                                                padding: '0 4px',
                                            }
                                        }}
                                    />
                                ) : (
                                    <Text
                                        size="sm"
                                        fw={isSelected ? 600 : 400}
                                        c={isSelected ? 'blue.4' : undefined}
                                        onDoubleClick={handleNameDoubleClick}
                                        style={{ cursor: 'default' }}
                                    >
                                        {channel.name}
                                    </Text>
                                )}
                                {channel.is_hidden && (
                                    <Tooltip label="Hidden from feed">
                                        <IconEyeOff size={14} style={{ color: 'var(--mantine-color-gray-6)', opacity: 0.6 }} />
                                    </Tooltip>
                                )}
                            </Group>
                            {isOver && isSingleStreamDragging && (
                                <Badge size="sm" color="blue" variant="filled">
                                    Add to this channel
                                </Badge>
                            )}
                            {isDraggingImageOver && (
                                <Badge size="sm" color="blue" variant="filled">
                                    Drop to set logo
                                </Badge>
                            )}
                        </Group>
                    </Table.Td>
                    <Table.Td style={{ width: 100 }}>
                        {channel.streams && channel.streams.length > 0 ? (
                            <Badge size="xs" variant="light" color="blue">
                                {channel.streams.length} stream
                                {channel.streams.length > 1 ? 's' : ''}
                            </Badge>
                        ) : (
                            <Badge size="xs" variant="light" color="gray">
                                Empty
                            </Badge>
                        )}
                    </Table.Td>
                    <Table.Td style={{ width: 80 }}>
                        {channel.epg_data_id ? (
                            <Badge size="xs" variant="light" color="green">
                                EPG
                            </Badge>
                        ) : (
                            <Badge size="xs" variant="light" color="gray">
                                —
                            </Badge>
                        )}
                    </Table.Td>
                    <Table.Td style={{ width: 80 }}>
                        {channel.is_adult ? (
                            <Badge size="xs" variant="light" color="orange">
                                Mature
                            </Badge>
                        ) : (
                            <Badge size="xs" variant="light" color="gray">
                                —
                            </Badge>
                        )}
                    </Table.Td>
                    <Table.Td style={{ width: 40 }}>
                        <Menu position="bottom-end" withinPortal>
                            <Menu.Target>
                                <ActionIcon size="sm" variant="subtle" onClick={e => e.stopPropagation()}>
                                    <IconDots size={14} />
                                </ActionIcon>
                            </Menu.Target>
                            <Menu.Dropdown>
                                <Menu.Item
                                    leftSection={<IconPlayerPlay size={14} />}
                                    onClick={handlePreviewChannel}
                                    disabled={!channel.streams || channel.streams.length === 0}
                                >
                                    Preview
                                </Menu.Item>
                                <Menu.Item leftSection={<IconEdit size={14} />} onClick={handleEdit}>
                                    Edit
                                </Menu.Item>
                                <Menu.Item
                                    leftSection={<IconPhoto size={14} />}
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        setImageUploadModalOpen(true);
                                    }}
                                >
                                    {logoUrl ? 'Change Logo' : 'Set Logo'}
                                </Menu.Item>
                                <Menu.Item
                                    leftSection={<IconCopy size={14} />}
                                    onClick={handleCopyURL}
                                >
                                    Copy URL
                                </Menu.Item>
                                <Menu.Item
                                    leftSection={<IconWand size={14} />}
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onMatchEpg?.([channel.id]);
                                    }}
                                >
                                    Auto-Match EPG
                                </Menu.Item>
                                <Menu.Item
                                    leftSection={channel.is_hidden ? <IconEye size={14} /> : <IconEyeOff size={14} />}
                                    onClick={handleToggleHidden}
                                >
                                    {channel.is_hidden ? 'Show Channel' : 'Hide Channel'}
                                </Menu.Item>
                                <Menu.Divider />
                                <Menu.Item
                                    leftSection={<IconTrash size={14} />}
                                    color="red"
                                    onClick={handleDelete}
                                >
                                    Delete Channel
                                </Menu.Item>
                            </Menu.Dropdown>
                        </Menu>
                    </Table.Td>
                </Table.Tr>

                {/* Stream sub-rows */}
                {expanded && (
                    <Table.Tr style={{ backgroundColor: 'rgba(0,0,0,0.15)' }}>
                        <Table.Td></Table.Td>
                        <Table.Td colSpan={4} p={0}>
                            <Table variant="unstyled" style={{ fontSize: '10px' }}>
                                <Table.Thead>
                                    <Table.Tr style={{ borderBottom: '1px solid var(--mantine-color-dark-4)' }}>
                                        <Table.Th py={2} style={{ width: '35%' }}>Stream Name</Table.Th>
                                        <Table.Th py={2} style={{ width: '12%' }}>ID</Table.Th>
                                        <Table.Th py={2} style={{ width: '18%' }}>TVG-ID</Table.Th>
                                        <Table.Th py={2} style={{ width: '25%' }}>Source</Table.Th>
                                        <Table.Th py={2} style={{ width: '10%' }}></Table.Th>
                                    </Table.Tr>
                                </Table.Thead>
                                <Table.Tbody>
                                    {channel.streams?.map((stream) => {
                                        const sName = typeof stream === 'object' ? (stream.name || stream.title) : `Stream #${stream}`;
                                        const sId = typeof stream === 'object' ? (stream.stream_id || stream.id) : stream;
                                        const sTvgId = typeof stream === 'object' ? (stream.tvg_id || '—') : '—';
                                        const sSource = typeof stream === 'object' ? (stream.m3u_account_name || stream.xtream_account_name || 'Custom') : '—';

                                        return (
                                            <Table.Tr
                                                key={stream.id || stream}
                                                onDoubleClick={() => handleWatchStream(stream)}
                                                style={{ cursor: 'pointer' }}
                                                className="stream-sub-row-hover"
                                            >
                                                <Table.Td py={4}>
                                                    <Group gap="xs" wrap="nowrap">
                                                        <Box w={2} h={14} bg="blue.6" style={{ borderRadius: 1 }} />
                                                        <Text size="xs" fw={500} truncate>{sName}</Text>
                                                    </Group>
                                                </Table.Td>
                                                <Table.Td py={4}>
                                                    <Text size="xs" c="dimmed">#{sId}</Text>
                                                </Table.Td>
                                                <Table.Td py={4}>
                                                    <Text size="xs" c="dimmed" truncate>{sTvgId}</Text>
                                                </Table.Td>
                                                <Table.Td py={4}>
                                                    <Text size="xs" c="dimmed" truncate>{sSource}</Text>
                                                </Table.Td>
                                                <Table.Td py={4} align="right">
                                                    <Menu position="bottom-end" withinPortal>
                                                        <Menu.Target>
                                                            <ActionIcon size="xs" variant="subtle" onClick={(e) => e.stopPropagation()}>
                                                                <IconDots size={12} />
                                                            </ActionIcon>
                                                        </Menu.Target>
                                                        <Menu.Dropdown>
                                                            <Menu.Item
                                                                leftSection={<IconEye size={12} />}
                                                                onClick={(e) => {
                                                                    e.stopPropagation();
                                                                    handleWatchStream(stream);
                                                                }}
                                                            >
                                                                Preview
                                                            </Menu.Item>
                                                            <Menu.Divider />
                                                            <Menu.Item
                                                                color="red"
                                                                leftSection={<IconTrash size={12} />}
                                                                onClick={(e) => {
                                                                    e.stopPropagation();
                                                                    handleDeleteStream(stream);
                                                                }}
                                                            >
                                                                Remove from channel
                                                            </Menu.Item>
                                                        </Menu.Dropdown>
                                                    </Menu>
                                                </Table.Td>
                                            </Table.Tr>
                                        );
                                    })}
                                </Table.Tbody>
                            </Table>
                        </Table.Td>
                    </Table.Tr>
                )}
            </Table.Tbody>
        </>
    );
});

const HelpModal = ({ opened, onClose }) => (
    <Modal opened={opened} onClose={onClose} title="Channel Organizer Help" size="lg">
        <Stack gap="md">
            <Box>
                <Text fw={600} mb="xs">Three-Panel Layout</Text>
                <Text size="sm" c="dimmed">
                    <strong>Left Panel (Channel Groups):</strong> Shows groups that have channels assigned. Use "Active" to see only groups with channels, or "All" to see every group including empty M3U source groups. Click a group to view its channels.
                </Text>
                <Text size="sm" c="dimmed" mt="xs">
                    <strong>Middle Panel (Channels):</strong> View and manage channels in the selected group. Filter by stream status, EPG status, and search by name.
                </Text>
                <Text size="sm" c="dimmed" mt="xs">
                    <strong>Right Panel (Stream Library):</strong> Browse all available streams organized by their M3U/Xtream source groups. Drag streams here to assign them to channels.
                </Text>
            </Box>
            <Box>
                <Text fw={600} mb="xs">Quick Actions</Text>
                <Text size="sm" c="dimmed">• Click <strong>+ Empty Channel</strong> to create a channel without streams</Text>
                <Text size="sm" c="dimmed">• Click the chevron on a channel to see its currently assigned streams</Text>
                <Text size="sm" c="dimmed">• <strong>Assign Stream:</strong> Drag a stream directly onto a channel row</Text>
                <Text size="sm" c="dimmed">• <strong>New Channel:</strong> Drag a stream into the gaps between channels</Text>
                <Text size="sm" c="dimmed">• Use the profile selector at the top to switch between profiles</Text>
            </Box>
        </Stack>
    </Modal>
);

const GroupChannelsPanel = ({ selectedGroup: selectedGroupProp, onRefreshRef, onOptimisticReorderRef, onMatchEpg }) => {
    // Derive the live group from the store so sort_mode/sort_field changes are reflected
    const storeGroup = useChannelsStore(
        (s) => selectedGroupProp ? s.channelGroups[selectedGroupProp.id] : null
    );
    const selectedGroup = storeGroup || selectedGroupProp;

    const [channels, setChannels] = useState([]);
    const [loading, setLoading] = useState(false);
    const [page, setPage] = useState(1);
    const [totalChannels, setTotalChannels] = useState(0);
    const [pageSize, setPageSize] = useState(50);
    const selectedProfileId = useChannelsStore((s) => s.selectedProfileId);
    const [searchQuery, setSearchQuery] = useState('');
    const debouncedSearch = useDebounce(searchQuery, 300);
    const [sourceFilter, setSourceFilter] = useState('all');
    const [m3uSourceFilter, setM3uSourceFilter] = useState('all');
    const [epgFilter, setEPGFilter] = useState('all');
    const [visibilityFilter, setVisibilityFilter] = useState('visible'); // visible, hidden, all
    const [helpOpened, setHelpOpened] = useState(false);

    const playlists = usePlaylistsStore((s) => s.playlists);
    const sourceOptions = useMemo(() => [
        { value: 'all', label: 'All Sources' },
        ...playlists.map(p => ({ value: `m3u-${p.id}`, label: p.name }))
    ], [playlists]);

    // Channel mutation state
    const [editingChannel, setEditingChannel] = useState(null);
    const [deletingChannel, setDeletingChannel] = useState(null);
    const [isDeleting, setIsDeleting] = useState(false);

    // Selection & Bulk State
    const [selectedIds, setSelectedIds] = useState(new Set());
    const [isBulkDeleting, setIsBulkDeleting] = useState(false);
    const [isBulkDeduping, setIsBulkDeduping] = useState(false);

    const handleToggleSelect = useCallback((id) => {
        setSelectedIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }, []);

    const loadChannels = useCallback(async () => {
        console.log('[GroupChannels] loadChannels called, selectedGroup:', selectedGroup?.name);
        if (!selectedGroup) return;
        setLoading(true);
        try {
            const params = new URLSearchParams({
                channel_group: selectedGroup.name,
                page: String(page),
                page_size: String(pageSize),
                include_streams: 'true',
            });
            if (selectedProfileId && selectedProfileId !== '0') {
                params.set('channel_profile_id', selectedProfileId);
            }

            // Apply filters to backend query
            if (debouncedSearch) {
                params.set('name', debouncedSearch);
            }
            if (sourceFilter === 'empty') {
                params.set('only_streamless', 'true');
            } else if (sourceFilter === 'with_streams') {
                params.set('only_with_streams', 'true');
            }
            if (epgFilter === 'with_epg') {
                params.set('has_epg', 'true');
            } else if (epgFilter === 'without_epg') {
                params.set('has_epg', 'false');
            }
            if (visibilityFilter === 'visible') {
                params.set('is_hidden', 'false');
            } else if (visibilityFilter === 'hidden') {
                params.set('is_hidden', 'true');
            }
            if (m3uSourceFilter && m3uSourceFilter !== 'all') {
                params.set('stream_source', m3uSourceFilter);
            }

            const response = await API.queryChannels(params);
            setChannels(response?.results || []);
            setTotalChannels(response?.count || 0);
        } catch (error) {
            console.error('Failed to load channels:', error);
        } finally {
            setLoading(false);
        }
    }, [selectedGroup, selectedProfileId, page, pageSize, debouncedSearch, sourceFilter, m3uSourceFilter, epgFilter, visibilityFilter]);

    const handleSelectAll = useCallback(async () => {
        if (selectedIds.size === totalChannels && totalChannels > 0) {
            setSelectedIds(new Set());
        } else {
            // Fetch all matching IDs across all pages from the backend
            const params = new URLSearchParams({
                channel_group: selectedGroup.name,
            });
            if (selectedProfileId && selectedProfileId !== '0') {
                params.set('channel_profile_id', selectedProfileId);
            }
            if (debouncedSearch) {
                params.set('name', debouncedSearch);
            }
            if (sourceFilter === 'empty') {
                params.set('only_streamless', 'true');
            } else if (sourceFilter === 'with_streams') {
                params.set('only_with_streams', 'true');
            }
            if (epgFilter === 'with_epg') {
                params.set('has_epg', 'true');
            } else if (epgFilter === 'without_epg') {
                params.set('has_epg', 'false');
            }
            if (visibilityFilter === 'visible') {
                params.set('is_hidden', 'false');
            } else if (visibilityFilter === 'hidden') {
                params.set('is_hidden', 'true');
            }
            const allIds = await API.queryChannelIds(params);
            setSelectedIds(new Set(allIds));
        }
    }, [selectedGroup, selectedProfileId, debouncedSearch, sourceFilter, epgFilter, visibilityFilter, selectedIds.size, totalChannels]);

    const handleBulkDelete = async () => {
        if (selectedIds.size === 0) return;
        setIsBulkDeleting(true);
        try {
            await API.bulkDeleteChannels(Array.from(selectedIds));
            setSelectedIds(new Set());
            // Refresh counts in the left panel
            await useChannelsStore.getState().fetchChannelProfiles();
            await useChannelsStore.getState().fetchChannelGroups();
            loadChannels();
        } catch (error) {
            console.error('Failed to bulk delete:', error);
        } finally {
            setIsBulkDeleting(false);
        }
    };

    const handleBulkDedupe = async () => {
        if (selectedIds.size === 0) return;
        setIsBulkDeduping(true);
        try {
            await API.bulkDedupeChannels(Array.from(selectedIds));
            setSelectedIds(new Set());
            // Refresh counts in the left panel
            await useChannelsStore.getState().fetchChannelProfiles();
            await useChannelsStore.getState().fetchChannelGroups();
            loadChannels();
        } catch (error) {
            console.error('Failed to dedupe channels:', error);
        } finally {
            setIsBulkDeduping(false);
        }
    };

    const handleBulkHide = async () => {
        if (selectedIds.size === 0) return;
        try {
            const updates = Array.from(selectedIds).map(id => ({ id, is_hidden: true }));
            await API.bulkEditChannels(updates);
            notifications.show({
                title: 'Channels Hidden',
                message: `Successfully hidden ${updates.length} channels`,
                color: 'blue'
            });
            setSelectedIds(new Set());
            loadChannels();
        } catch (error) {
            console.error('Failed to hide channels:', error);
        }
    };

    const handleBulkShow = async () => {
        if (selectedIds.size === 0) return;
        try {
            const updates = Array.from(selectedIds).map(id => ({ id, is_hidden: false }));
            await API.bulkEditChannels(updates);
            notifications.show({
                title: 'Channels Visible',
                message: `Successfully showed ${updates.length} channels`,
                color: 'teal'
            });
            setSelectedIds(new Set());
            loadChannels();
        } catch (error) {
            console.error('Failed to show channels:', error);
        }
    };

    const handleBulkToggleMature = async (isMature) => {
        if (selectedIds.size === 0) return;
        try {
            const updates = Array.from(selectedIds).map(id => ({ id, is_adult: isMature }));
            await API.bulkEditChannels(updates);
            notifications.show({
                title: isMature ? 'Channels Flagged Mature' : 'Channels Unflagged Mature',
                message: `Successfully ${isMature ? 'flagged' : 'unflagged'} ${updates.length} channels as mature`,
                color: isMature ? 'orange' : 'teal'
            });
            setSelectedIds(new Set());
            loadChannels();
        } catch (error) {
            console.error('Failed to toggle mature status:', error);
        }
    };




    // Track drag state at parent level — fires once on start/end, NOT per mouse move
    const [isStreamDragging, setIsStreamDragging] = useState(false);
    const [isSingleStreamDragging, setIsSingleStreamDragging] = useState(false); // Only true for single streams, not groups

    useDndMonitor({
        onDragStart(event) {
            const type = event.active.data.current?.type;
            const isStream = type === 'stream';
            const isStreamGroup = type === 'stream-group';
            setIsStreamDragging(isStream || isStreamGroup);
            setIsSingleStreamDragging(isStream); // Only single streams can be dropped on channels
        },
        onDragEnd() {
            setIsStreamDragging(false);
            setIsSingleStreamDragging(false);
        },
        onDragCancel() {
            setIsStreamDragging(false);
            setIsSingleStreamDragging(false);
        },
    });

    const { setNodeRef, isOver } = useDroppable({
        id: 'channel-drop-zone',
        data: {
            type: 'channel-drop-zone',
        },
        disabled: !selectedGroup,
    });

    const isStreamDragOver = isOver && isStreamDragging;
    const isManualSort = (selectedGroup?.sort_mode || 'manual') === 'manual';

    useEffect(() => {
        if (selectedGroup) {
            loadChannels();
        } else {
            setChannels([]);
        }
    }, [loadChannels]);

    // Reset page to 1 whenever the group, profile, or filters change
    useEffect(() => {
        setPage(1);
    }, [selectedGroup?.id, selectedProfileId, pageSize, debouncedSearch, sourceFilter, m3uSourceFilter, epgFilter, visibilityFilter]);

    // Register loadChannels so parent can trigger refresh (e.g. after DnD)
    useEffect(() => {
        if (onRefreshRef) {
            console.log('[GroupChannels] Registering loadChannels with parent');
            onRefreshRef.current = loadChannels;
        }
    }, [onRefreshRef, loadChannels]);

    // Register optimistic reorder callback
    useEffect(() => {
        if (onOptimisticReorderRef) {
            console.log('[GroupChannels] Registering optimistic reorder callback');
            onOptimisticReorderRef.current = (activeId, overId) => {
                console.log(`[GroupChannels] Optimistic reorder: ${activeId} -> ${overId}`);
                setChannels(prevChannels => {
                    const oldIndex = prevChannels.findIndex(c => c.id === activeId);
                    const newIndex = prevChannels.findIndex(c => c.id === overId);

                    if (oldIndex === -1 || newIndex === -1) {
                        console.warn('[GroupChannels] Cannot find channels for optimistic reorder');
                        return prevChannels;
                    }

                    // Create a new array with the reordered channels
                    const newChannels = [...prevChannels];
                    const [movedChannel] = newChannels.splice(oldIndex, 1);
                    newChannels.splice(newIndex, 0, movedChannel);

                    console.log('[GroupChannels] Optimistic reorder applied');
                    return newChannels;
                });
            };
        }
    }, [onOptimisticReorderRef]);

    const handleCreateEmpty = async (name) => {
        try {
            await API.createEmptyChannel({
                name,
                channel_group_id: selectedGroup?.id,
            });
            // Refresh counts in the left panel
            await useChannelsStore.getState().fetchChannelProfiles();
            await useChannelsStore.getState().fetchChannelGroups();
            loadChannels();
        } catch (error) {
            console.error('Failed to create empty channel:', error);
        }
    };

    const handleEditChannel = (channel) => {
        setEditingChannel(channel);
    };

    const handleDeleteChannel = (channel) => {
        setDeletingChannel(channel);
    };

    const executeDelete = async () => {
        if (!deletingChannel) return;
        setIsDeleting(true);
        try {
            await API.deleteChannel(deletingChannel.id);

            // Remove the deleted channel from selectedIds if it was selected
            setSelectedIds(prev => {
                const newSet = new Set(prev);
                newSet.delete(deletingChannel.id);
                return newSet;
            });

            await useChannelsStore.getState().fetchChannelProfiles();
            await useChannelsStore.getState().fetchChannelGroups();
            loadChannels();
            setDeletingChannel(null);
        } catch (error) {
            console.error('Failed to delete channel:', error);
        } finally {
            setIsDeleting(false);
        }
    };


    const filteredChannels = channels;

    return (
        <Box ref={setNodeRef} h="100%" display="flex" style={{
            flexDirection: 'column',
            outline: isStreamDragOver ? '2px dashed var(--mantine-color-blue-6)' : 'none',
            outlineOffset: '-4px',
            backgroundColor: isStreamDragOver ? 'rgba(34, 139, 230, 0.04)' : 'transparent',
            boxShadow: isStreamDragOver ? 'inset 0 0 60px rgba(34, 139, 230, 0.1)' : 'none',
            transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
            borderRadius: 8,
            position: 'relative',
        }}>
            <HelpModal opened={helpOpened} onClose={() => setHelpOpened(false)} />

            {editingChannel && (
                <ChannelForm
                    isOpen={!!editingChannel}
                    channel={editingChannel}
                    onClose={() => {
                        setEditingChannel(null);
                        loadChannels();
                    }}
                />
            )}

            <ConfirmationDialog
                opened={!!deletingChannel}
                onClose={() => setDeletingChannel(null)}
                onConfirm={executeDelete}
                title="Delete Channel"
                message={`Are you sure you want to delete channel "${deletingChannel?.name}"? This action cannot be undone.`}
                confirmLabel="Delete"
                confirmColor="red"
                loading={isDeleting}
            />



            <Box
                p="sm"
                style={{ borderBottom: '1px solid var(--mantine-color-dark-4)' }}
            >
                <Stack gap="xs">
                    <Group justify="space-between">
                        <Group gap="xs">
                            <Text fw={600} size="md">
                                {selectedGroup ? selectedGroup.name : 'Select a Group'}
                            </Text>
                            {selectedGroup && (
                                <Badge size="xs" variant="light">
                                    {totalChannels} channel{totalChannels !== 1 ? 's' : ''}
                                </Badge>
                            )}
                            <Tooltip label="Help">
                                <ActionIcon
                                    variant="subtle"
                                    size="xs"
                                    onClick={() => setHelpOpened(true)}
                                >
                                    <IconHelp size={14} />
                                </ActionIcon>
                            </Tooltip>
                        </Group>
                        {selectedGroup && (
                            <InlineAddPopover
                                tooltipLabel="Create Empty Channel"
                                placeholder="Channel Name"
                                onSubmit={handleCreateEmpty}
                                color="blue"
                            >
                                <Button
                                    size="compact-xs"
                                    leftSection={<IconPlus size={12} />}
                                    variant="light"
                                >
                                    Empty Channel
                                </Button>
                            </InlineAddPopover>
                        )}
                    </Group>

                    {selectedGroup && (
                        <Group gap="xs">
                            <TextInput
                                placeholder="Search channels..."
                                leftSection={<IconSearch size={14} />}
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                size="xs"
                                style={{ flex: 1 }}
                            />
                            <Select
                                data={[
                                    { value: 'all', label: 'All' },
                                    { value: 'empty', label: 'Empty' },
                                    { value: 'with_streams', label: 'Has Streams' },
                                ]}
                                value={sourceFilter}
                                onChange={setSourceFilter}
                                size="xs"
                                w={110}
                                clearable={false}
                            />
                            <Select
                                data={sourceOptions}
                                value={m3uSourceFilter}
                                onChange={setM3uSourceFilter}
                                size="xs"
                                w={140}
                                clearable={false}
                            />
                            <Select
                                data={[
                                    { value: 'all', label: 'All' },
                                    { value: 'with_epg', label: 'EPG' },
                                    { value: 'without_epg', label: 'No EPG' },
                                ]}
                                value={epgFilter}
                                onChange={setEPGFilter}
                                size="xs"
                                w={100}
                                clearable={false}
                            />
                            <Select
                                data={[
                                    { value: 'visible', label: 'Visible' },
                                    { value: 'hidden', label: 'Hidden' },
                                    { value: 'all', label: 'All' },
                                ]}
                                value={visibilityFilter}
                                onChange={setVisibilityFilter}
                                size="xs"
                                w={100}
                                clearable={false}
                            />
                        </Group>
                    )}
                    {selectedGroup && (
                        <Group gap="xs" align="center">
                            <IconArrowsSort size={14} style={{ opacity: 0.6 }} />
                            <SegmentedControl
                                size="xs"
                                data={[
                                    { value: 'manual', label: 'Manual' },
                                    { value: 'auto', label: 'Auto' },
                                ]}
                                value={selectedGroup.sort_mode || 'manual'}
                                onChange={async (val) => {
                                    await API.updateGroupSortSettings(
                                        selectedGroup.id,
                                        val,
                                        val === 'auto' ? (selectedGroup.sort_field || 'channel_number_asc') : null
                                    );
                                    loadChannels();
                                }}
                            />
                            {(selectedGroup.sort_mode || 'manual') === 'auto' && (
                                <Select
                                    size="xs"
                                    w={180}
                                    data={[
                                        { value: 'channel_number_asc', label: 'Ch# Ascending' },
                                        { value: 'channel_number_desc', label: 'Ch# Descending' },
                                        { value: 'name_asc', label: 'Name A→Z' },
                                        { value: 'name_desc', label: 'Name Z→A' },
                                    ]}
                                    value={selectedGroup.sort_field || 'channel_number_asc'}
                                    onChange={async (val) => {
                                        await API.updateGroupSortSettings(selectedGroup.id, 'auto', val);
                                        loadChannels();
                                    }}
                                    clearable={false}
                                />
                            )}
                        </Group>
                    )}
                </Stack>
            </Box>

            {selectedGroup ? (
                <>
                    <Box
                        style={{
                            flex: 1,
                            display: 'flex',
                            flexDirection: 'column',
                            position: 'relative',
                            overflow: 'hidden'
                        }}
                    >
                        <ScrollArea
                            style={{
                                flex: 1,
                                // When dragging, reduce height to make room for the drop zone
                                maxHeight: isStreamDragging ? 'calc(100% - 160px)' : '100%',
                                transition: 'max-height 0.2s ease'
                            }}
                            scrollbarSize={6}
                        >
                            <Table striped highlightOnHover stickyHeader style={{ tableLayout: 'fixed' }}>
                                <Table.Thead>
                                    <Table.Tr>
                                        <Table.Th style={{ width: isManualSort ? 110 : 80 }}>
                                            <Group gap="xs" wrap="nowrap">
                                                <Checkbox
                                                    size="xs"
                                                    checked={selectedIds.size === totalChannels && totalChannels > 0}
                                                    indeterminate={selectedIds.size > 0 && selectedIds.size < totalChannels}
                                                    onChange={handleSelectAll}
                                                />
                                                <Text size="xs" fw={700}>#</Text>
                                            </Group>
                                        </Table.Th>
                                        <Table.Th>Name</Table.Th>
                                        <Table.Th style={{ width: 100 }}>Streams</Table.Th>
                                        <Table.Th style={{ width: 80 }}>EPG</Table.Th>
                                        <Table.Th style={{ width: 80 }}>Mature</Table.Th>
                                        <Table.Th style={{ width: 40 }}></Table.Th>
                                    </Table.Tr>
                                </Table.Thead>
                                <SortableContext items={(filteredChannels || []).filter(c => c && c.id).map(c => `channel-${c.id}`)} strategy={verticalListSortingStrategy}>
                                    {(filteredChannels || []).length > 0 ? (
                                        filteredChannels.filter(c => c && c.id).map((channel, idx) => (
                                            <React.Fragment key={channel.id}>
                                                {isStreamDragging && isManualSort && (
                                                    <Table.Tbody>
                                                        <DropGap index={idx} beforeId={channel.id} isStreamDragging />
                                                    </Table.Tbody>
                                                )}
                                                <ChannelRowGroup
                                                    channel={channel}
                                                    onRefresh={loadChannels}
                                                    onEdit={handleEditChannel}
                                                    onDelete={handleDeleteChannel}
                                                    onMatchEpg={onMatchEpg}
                                                    isStreamDragging={isStreamDragging}
                                                    isSingleStreamDragging={isSingleStreamDragging}
                                                    isSelected={selectedIds.has(channel.id)}
                                                    onToggleSelect={handleToggleSelect}
                                                    isManualSort={isManualSort}
                                                />
                                            </React.Fragment>
                                        ))
                                    ) : null}
                                </SortableContext>
                            </Table>

                            {(filteredChannels || []).length === 0 && !loading && (
                                <Box py={60} display="flex" style={{ flex: 1, alignItems: 'center', justifyContent: 'center', flexDirection: 'column' }}>
                                    <IconPlus size={48} style={{ opacity: 0.1, marginBottom: 16 }} />
                                    <Text c="dimmed" size="sm">No channels found in this group.</Text>
                                    <Text c="dimmed" size="xs">Drag streams from the right to create channels.</Text>
                                </Box>
                            )}
                            {totalChannels > pageSize && (
                                <Box py="xs">
                                    <Group gap={5} justify="center">
                                        <Text size="xs">Page Size</Text>
                                        <NativeSelect
                                            size="xxs"
                                            value={pageSize}
                                            data={['25', '50', '100', '500', '1000', '2000', '5000', '10000']}
                                            onChange={(e) => setPageSize(Number(e.target.value))}
                                            style={{ paddingRight: 10 }}
                                        />
                                        <Pagination
                                            total={Math.ceil((totalChannels || 0) / pageSize) || 1}
                                            value={page}
                                            onChange={setPage}
                                            size="xs"
                                            siblings={1}
                                            boundaries={0}
                                        />
                                    </Group>
                                </Box>
                            )}
                        </ScrollArea>

                        {/* Bottom drop zone - positioned at bottom of viewport when dragging */}
                        {isStreamDragging && (
                            <Box style={{
                                position: 'absolute',
                                bottom: 0,
                                left: 0,
                                right: 0,
                                zIndex: 100,
                            }}>
                                <EndDropZone
                                    index={(filteredChannels || []).length}
                                    isStreamDragging={isStreamDragging}
                                />
                            </Box>
                        )}
                    </Box>
                </>
            ) : (
                <Box
                    style={{
                        flex: 1,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                    }}
                >
                    <Text c="dimmed" size="sm">
                        Select a group from the left panel
                    </Text>
                </Box>
            )}

            {/* Bulk Action Bar */}
            <Transition mounted={selectedIds.size > 0} transition="slide-up" duration={400} timingFunction="ease">
                {(styles) => (
                    <Box
                        style={{
                            ...styles,
                            position: 'absolute',
                            bottom: 30,
                            left: '50%',
                            transform: 'translateX(-50%)',
                            zIndex: 1000,
                            width: 'max-content',
                        }}
                    >
                        <Group
                            p="sm"
                            px="lg"
                            style={{
                                borderRadius: 100,
                                background: 'rgba(26, 27, 30, 0.85)',
                                backdropFilter: 'blur(16px) saturate(180%)',
                                border: '1px solid rgba(255, 255, 255, 0.12)',
                                boxShadow: '0 12px 40px rgba(0, 0, 0, 0.4), inset 0 0 0 1px rgba(255, 255, 255, 0.05)',
                            }}
                            gap="md"
                        >
                            <Group gap="xs">
                                <Box style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                    <Box
                                        style={{
                                            position: 'absolute',
                                            inset: -4,
                                            background: 'var(--mantine-color-blue-9)',
                                            borderRadius: '50%',
                                            opacity: 0.2,
                                            filter: 'blur(8px)',
                                        }}
                                    />
                                    <Badge
                                        size="lg"
                                        circle
                                        color="blue"
                                        variant="filled"
                                        style={{
                                            width: 28,
                                            height: 28,
                                            fontSize: '13px',
                                            boxShadow: '0 0 15px rgba(34, 139, 230, 0.4)'
                                        }}
                                    >
                                        {selectedIds.size}
                                    </Badge>
                                </Box>
                            </Group>

                            <Box w={1} h={20} bg="rgba(255,255,255,0.1)" />

                            <Group gap="xs">
                                <Tooltip label="Cancel selection">
                                    <ActionIcon
                                        variant="subtle"
                                        color="gray.4"
                                        size="md"
                                        radius="xl"
                                        onClick={() => setSelectedIds(new Set())}
                                        style={{ '&:hover': { backgroundColor: 'rgba(255,255,255,0.05)' } }}
                                    >
                                        <IconCircleX size={18} />
                                    </ActionIcon>
                                </Tooltip>

                                <Button
                                    variant="gradient"
                                    gradient={{ from: 'blue.6', to: 'cyan.6' }}
                                    size="compact-sm"
                                    radius="xl"
                                    onClick={() => {
                                        onMatchEpg?.(Array.from(selectedIds));
                                        setSelectedIds(new Set());
                                    }}
                                    leftSection={<IconWand size={14} />}
                                    styles={{
                                        root: { boxShadow: '0 4px 12px rgba(34, 139, 230, 0.3)' }
                                    }}
                                >
                                    Match EPG
                                </Button>

                                <Box w={1} h={20} bg="rgba(255,255,255,0.08)" />

                                <Button.Group>
                                    <Button
                                        size="compact-xs"
                                        variant="light"
                                        color="gray"
                                        onClick={handleBulkHide}
                                        leftSection={<IconEyeOff size={14} />}
                                    >
                                        Hide
                                    </Button>
                                    <Button
                                        size="compact-xs"
                                        variant="light"
                                        color="teal"
                                        onClick={handleBulkShow}
                                        leftSection={<IconEye size={14} />}
                                    >
                                        Show
                                    </Button>
                                </Button.Group>

                                <Button.Group>
                                    <Button
                                        size="compact-xs"
                                        variant="light"
                                        color="orange"
                                        onClick={() => handleBulkToggleMature(true)}
                                    >
                                        Mark Mature
                                    </Button>
                                    <Button
                                        size="compact-xs"
                                        variant="light"
                                        color="teal"
                                        onClick={() => handleBulkToggleMature(false)}
                                    >
                                        Mark Safe
                                    </Button>
                                </Button.Group>

                                <Box w={1} h={20} bg="rgba(255,255,255,0.08)" />

                                <Tooltip label="Dedupe streams">
                                    <ActionIcon
                                        variant="light"
                                        color="orange"
                                        size="md"
                                        radius="xl"
                                        loading={isBulkDeduping}
                                        onClick={handleBulkDedupe}
                                        styles={{
                                            root: {
                                                backgroundColor: 'rgba(247, 103, 7, 0.1)',
                                                '&:hover': { backgroundColor: 'rgba(247, 103, 7, 0.2)' }
                                            }
                                        }}
                                    >
                                        <IconStack size={18} />
                                    </ActionIcon>
                                </Tooltip>

                                <Tooltip label="Delete channels">
                                    <ActionIcon
                                        variant="filled"
                                        color="red.8"
                                        size="md"
                                        radius="xl"
                                        loading={isBulkDeleting}
                                        onClick={handleBulkDelete}
                                        styles={{
                                            root: { boxShadow: '0 4px 12px rgba(230, 73, 73, 0.3)' }
                                        }}
                                    >
                                        <IconTrashFilled size={18} />
                                    </ActionIcon>
                                </Tooltip>
                            </Group>
                        </Group>
                    </Box>
                )}
            </Transition>
        </Box>
    );
};

export default GroupChannelsPanel;
