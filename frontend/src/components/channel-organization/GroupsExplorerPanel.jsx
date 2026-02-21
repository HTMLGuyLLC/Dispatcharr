import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useDebounce } from '../../utils';
import {
    Box,
    TextInput,
    Stack,
    Group,
    ActionIcon,
    Text,
    Menu,
    ScrollArea,
    Collapse,
    Image,
    Badge,
    Tooltip,
    UnstyledButton,
    Modal,
    Button,
    Center,
    Loader,
} from '@mantine/core';
import { Dropzone } from '@mantine/dropzone';
import { Upload, FileImage, X as LucideX } from 'lucide-react';
import { notifications } from '@mantine/notifications';
import { useSortable, SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useDroppable } from '@dnd-kit/core';
import {
    IconSearch,
    IconFolder,
    IconFolderOpen,
    IconChevronRight,
    IconChevronDown,
    IconDots,
    IconEdit,
    IconTrash,
    IconCopy,
    IconPhoto,
    IconUsers,
    IconGripVertical,
    IconPlus,
    IconWand,
    IconEye,
    IconEyeOff,
    IconX,
    IconArrowsShuffle,
} from '@tabler/icons-react';

import useChannelsStore from '../../store/channels';
import API from '../../api';
import InlineAddPopover from './InlineAddPopover';
import ConfirmationDialog from '../ConfirmationDialog';
import CreateProfileModal from '../modals/CreateProfileModal';
import VideoPreviewPanel from './VideoPreviewPanel';


/* ─── Image Upload Modal ─── */
const ImageUploadModal = ({ opened, onClose, group, onSuccess }) => {
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
            // Upload the logo first
            // Sanitize the group name for the logo filename
            const sanitizedGroupName = group.name.replace(/[^a-zA-Z0-9]/g, '_');
            const uploadResponse = await API.uploadLogo(selectedFile, `${sanitizedGroupName}_Logo`);

            // Update the channel group with the new logo ID, include all required fields for PUT
            await API.updateChannelGroup({
                id: group.id,
                name: group.name,
                image: uploadResponse.id,
                sort_mode: group.sort_mode || 'auto',
                sort_field: group.sort_field || 'name_asc'
            });

            notifications.show({
                title: 'Success',
                message: 'Group image updated successfully',
                color: 'green',
            });

            onSuccess?.();
            onClose();
        } catch (error) {
            console.error('Failed to upload image:', error);
            notifications.show({
                title: 'Error',
                message: error?.body?.detail || error?.message || 'Failed to upload image',
                color: 'red',
            });
        } finally {
            setUploading(false);
        }
    };

    const handleRemoveImage = async () => {
        setUploading(true);
        try {
            // Include all required fields for PUT, set image to null
            await API.updateChannelGroup({
                id: group.id,
                name: group.name,
                image: null,
                sort_mode: group.sort_mode || 'auto',
                sort_field: group.sort_field || 'name_asc'
            });

            notifications.show({
                title: 'Success',
                message: 'Group image removed',
                color: 'green',
            });

            onSuccess?.();
            onClose();
        } catch (error) {
            console.error('Failed to remove image:', error);
            notifications.show({
                title: 'Error',
                message: error?.body?.detail || error?.message || 'Failed to remove image',
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

    return (
        <Modal
            opened={opened}
            onClose={onClose}
            title={group?.image_url ? 'Change Group Image' : 'Set Group Image'}
            size="md"
        >
            <Stack spacing="md">
                {(preview || group?.image_url) && (
                    <Center>
                        <Box>
                            <Text size="sm" color="dimmed" mb="xs" ta="center">
                                Preview
                            </Text>
                            <Image
                                src={preview || group.image_url}
                                alt="Group image preview"
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
                                    ? `Selected: ${selectedFile.name}`
                                    : 'Drag image here or click to select'}
                            </Text>
                            <Text size="sm" color="dimmed" inline mt={7}>
                                Supports PNG, JPEG, GIF, WebP, SVG files (max 5MB)
                            </Text>
                        </div>
                    </Group>
                </Dropzone>

                <Group justify="flex-end" mt="md">
                    {group?.image_url && (
                        <Button
                            variant="light"
                            color="red"
                            onClick={handleRemoveImage}
                            loading={uploading}
                        >
                            Remove Image
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

/* ─── Image Preview Modal ─── */
const ImagePreviewModal = ({ opened, onClose, imageUrl, groupName }) => {
    return (
        <Modal
            opened={opened}
            onClose={onClose}
            title={groupName}
            size="lg"
            centered
        >
            <Center>
                <Image
                    src={imageUrl}
                    alt={groupName}
                    fit="contain"
                    style={{ maxHeight: '70vh' }}
                />
            </Center>
        </Modal>
    );
};

/* ─── Single group row (nested under a profile) ─── */
const GroupItem = React.memo(({ group, isSelected, onSelect, profileId, onRename, onDelete, onDuplicate, onMatchEpg, onRemapChannels, fetchChannelGroups, fetchChannelProfiles }) => {
    const [isEditing, setIsEditing] = useState(false);
    const [editValue, setEditValue] = useState(group.name);
    const inputRef = React.useRef(null);
    const [imageUploadModalOpen, setImageUploadModalOpen] = useState(false);
    const [imagePreviewModalOpen, setImagePreviewModalOpen] = useState(false);
    const [isDraggingOver, setIsDraggingOver] = useState(false);

    const sortData = useMemo(() => ({
        type: 'group',
        group,
        profileId,
    }), [group, profileId]);

    const {
        attributes,
        listeners,
        setNodeRef,
        transform,
        transition,
        isDragging,
    } = useSortable({
        id: `group-${group.id}`,
        data: sortData,
    });

    // Focus input when entering edit mode
    useEffect(() => {
        if (isEditing && inputRef.current) {
            inputRef.current.focus();
            inputRef.current.select();
        }
    }, [isEditing]);

    const handleDoubleClick = (e) => {
        e.stopPropagation();
        setEditValue(group.name);
        setIsEditing(true);
    };

    const handleSave = async () => {
        if (editValue.trim() && editValue !== group.name) {
            try {
                await API.updateChannelGroup({ id: group.id, name: editValue.trim() });
                await fetchChannelProfiles();
                await fetchChannelGroups();
            } catch (error) {
                console.error('Failed to rename group:', error);
                // Reset to original name on error
                setEditValue(group.name);
            }
        }
        setIsEditing(false);
    };

    const handleCancel = () => {
        setEditValue(group.name);
        setIsEditing(false);
    };

    const handleKeyDown = (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            handleSave();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            handleCancel();
        }
    };

    const handleToggleHidden = async (e) => {
        e.stopPropagation();
        try {
            const newIsActive = !group.is_active;
            await API.toggleProfileGroup(profileId, group.id, newIsActive);
            await fetchChannelProfiles();
            await fetchChannelGroups();
        } catch (error) {
            console.error('Failed to toggle group visibility:', error);
        }
    };

    const style = {
        transform: CSS.Translate.toString(transform),
        transition,
        opacity: isDragging ? 0.3 : 1,
        cursor: 'pointer',
        borderRadius: 6,
        backgroundColor: isDragging
            ? 'var(--mantine-color-blue-1)'
            : isSelected
                ? 'var(--mantine-color-blue-light)'
                : 'transparent',
        border: isDragging ? '1px dashed var(--mantine-color-blue-5)' : '1px solid transparent',
        marginLeft: 4,
        position: 'relative',
        zIndex: isDragging ? 1001 : 'auto',
    };

    const hasImage = group.image_url;
    const channelCount = group.channel_count || 0;

    const handleDragOver = useCallback((e) => {
        e.preventDefault();
        e.stopPropagation();

        // Check if dragging an image file
        const hasImageFile = Array.from(e.dataTransfer.items).some(
            item => item.kind === 'file' && item.type.startsWith('image/')
        );

        if (hasImageFile) {
            setIsDraggingOver(true);
        }
    }, []);

    const handleDragLeave = useCallback((e) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDraggingOver(false);
    }, []);

    const handleDrop = useCallback(async (e) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDraggingOver(false);

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
            // Use the filename as the logo name, or generate one from group name if empty
            // Sanitize filename to avoid URL encoding issues
            let logoName = file.name ? file.name.replace(/[^a-zA-Z0-9.]/g, '_') : '';
            if (!logoName.trim()) {
                const timestamp = Date.now();
                const extension = file.type.split('/')[1] || 'png';
                logoName = `${group.name.replace(/[^a-zA-Z0-9]/g, '_')}_${timestamp}.${extension}`;
            }

            const uploadResponse = await API.uploadLogo(file, logoName);

            // Use 'image' field, and include all required fields for PUT request
            await API.updateChannelGroup({
                id: group.id,
                name: group.name,
                image: uploadResponse.id,
                sort_mode: group.sort_mode || 'auto',
                sort_field: group.sort_field || 'name_asc'
            });

            notifications.show({
                title: 'Success',
                message: 'Group image updated successfully',
                color: 'green',
            });

            await fetchChannelGroups();
            await fetchChannelProfiles();
        } catch (error) {
            console.error('Failed to upload image:', error);
            notifications.show({
                title: 'Error',
                message: error?.body?.detail || error?.message || 'Failed to upload image',
                color: 'red',
            });
        }
    }, [group, fetchChannelGroups, fetchChannelProfiles]);

    const handleImageClick = useCallback((e) => {
        e.stopPropagation();
        if (hasImage) {
            setImagePreviewModalOpen(true);
        }
    }, [hasImage]);

    return (
        <>
            <ImageUploadModal
                opened={imageUploadModalOpen}
                onClose={() => setImageUploadModalOpen(false)}
                group={group}
                onSuccess={async () => {
                    await fetchChannelGroups();
                    await fetchChannelProfiles();
                }}
            />

            <ImagePreviewModal
                opened={imagePreviewModalOpen}
                onClose={() => setImagePreviewModalOpen(false)}
                imageUrl={group.image_url}
                groupName={group.name}
            />

            <Group
                ref={setNodeRef}
                gap="xs"
                p="4px 8px"
                style={{
                    ...style,
                    outline: isDraggingOver ? '2px dashed var(--mantine-color-blue-6)' : style.border,
                    backgroundColor: isDraggingOver ? 'rgba(34, 139, 230, 0.1)' : style.backgroundColor,
                }}
                onClick={() => !isEditing && onSelect(group)}
                className="group-item-hover"
                wrap="nowrap"
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
            >
                <Box
                    {...attributes}
                    {...listeners}
                    className="drag-handle"
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        cursor: 'grab',
                        opacity: 0, // Hidden by default, shown on hover via CSS
                    }}
                >
                    <IconGripVertical size={14} />
                </Box>

                {hasImage ? (
                    <Tooltip label="Click to enlarge" withArrow>
                        <Box
                            onClick={handleImageClick}
                            style={{ cursor: 'pointer', position: 'relative' }}
                        >
                            <Image
                                src={group.image_url}
                                w={16}
                                h={16}
                                fit="contain"
                                radius="sm"
                            />
                        </Box>
                    </Tooltip>
                ) : (
                    <Box style={{ width: 16, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        {isSelected ? (
                            <IconFolderOpen size={14} style={{ color: 'var(--mantine-color-blue-5)' }} />
                        ) : (
                            <IconFolder size={14} style={{ color: 'var(--mantine-color-gray-6)' }} />
                        )}
                    </Box>
                )}

                {isEditing ? (
                    <TextInput
                        ref={inputRef}
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        onKeyDown={handleKeyDown}
                        onBlur={handleSave}
                        onClick={(e) => e.stopPropagation()}
                        size="xs"
                        style={{ flex: 1 }}
                        styles={{
                            input: {
                                minHeight: 20,
                                height: 20,
                                fontSize: 'var(--mantine-font-size-xs)',
                                padding: '0 4px',
                            }
                        }}
                    />
                ) : (
                    <Group gap={4} style={{ flex: 1, minWidth: 0 }}>
                        {group.is_active === false && (
                            <IconEyeOff size={12} style={{ color: 'var(--mantine-color-gray-6)', flexShrink: 0 }} />
                        )}
                        <Text
                            size="xs"
                            fw={isSelected ? 600 : 400}
                            style={{ flex: 1 }}
                            truncate
                            onDoubleClick={handleDoubleClick}
                        >
                            {group.name}
                        </Text>
                    </Group>
                )}

                <Badge size="xs" variant="light" color={channelCount > 0 ? 'blue' : 'gray'}>
                    {channelCount}
                </Badge>

                <Menu position="bottom-end" withinPortal>
                    <Menu.Target>
                        <ActionIcon
                            size="xs"
                            variant="subtle"
                            onClick={(e) => e.stopPropagation()}
                            className="row-action-btn"
                        >
                            <IconDots size={12} />
                        </ActionIcon>
                    </Menu.Target>
                    <Menu.Dropdown>
                        <Menu.Item
                            leftSection={<IconEdit size={14} />}
                            onClick={(e) => { e.stopPropagation(); onRename(group); }}
                        >
                            Rename
                        </Menu.Item>
                        <Menu.Item
                            leftSection={<IconPhoto size={14} />}
                            onClick={(e) => {
                                e.stopPropagation();
                                setImageUploadModalOpen(true);
                            }}
                        >
                            {hasImage ? 'Change Image' : 'Set Image'}
                        </Menu.Item>
                        <Menu.Item
                            leftSection={<IconCopy size={14} />}
                            onClick={(e) => { e.stopPropagation(); onDuplicate(group, profileId); }}
                        >
                            Duplicate
                        </Menu.Item>
                        <Menu.Item
                            leftSection={<IconWand size={14} />}
                            onClick={(e) => {
                                e.stopPropagation();
                                onMatchEpg?.([], { channelGroup: group.id, scopeLabel: `all channels in group "${group.name}"` });
                            }}
                        >
                            Auto-Match EPG
                        </Menu.Item>
                        <Menu.Item
                            leftSection={<IconArrowsShuffle size={14} />}
                            onClick={(e) => {
                                e.stopPropagation();
                                onRemapChannels?.({ channelGroupId: group.id, scopeLabel: `group "${group.name}"` });
                            }}
                        >
                            Remap Channels
                        </Menu.Item>
                        <Menu.Item
                            leftSection={group.is_active === false ? <IconEye size={14} /> : <IconEyeOff size={14} />}
                            onClick={handleToggleHidden}
                        >
                            {group.is_active === false ? 'Show Group' : 'Hide Group'}
                        </Menu.Item>
                        <Menu.Divider />
                        <Menu.Item
                            leftSection={<IconTrash size={14} />}
                            color="red"
                            onClick={(e) => { e.stopPropagation(); onDelete(group); }}
                        >
                            Delete
                        </Menu.Item>
                    </Menu.Dropdown>
                </Menu>
            </Group>
        </>
    );
});

/* ─── Expandable profile section ─── */
const ProfileSection = React.memo(({
    profile,
    isExpanded,
    onToggle,
    selectedGroup,
    onSelectGroup,
    groups = [],
    onAddGroup,
    searchQuery,
    onRenameGroup,
    onDeleteGroup,
    onDuplicateGroup,
    onRenameProfile,
    onDeleteProfile,
    onMatchEpg,
    onRemapChannels,
    fetchChannelGroups,
    fetchChannelProfiles,
}) => {
    const [isEditingProfile, setIsEditingProfile] = useState(false);
    const [editProfileValue, setEditProfileValue] = useState(profile.name);
    const profileInputRef = React.useRef(null);

    const totalGroups = groups.length;
    const totalChannels = groups.reduce((acc, g) => acc + (g.channel_count || 0), 0);

    const dropData = useMemo(() => ({
        type: 'profile-header',
        profileId: profile.id,
    }), [profile.id]);

    const { setNodeRef, isOver } = useDroppable({
        id: `profile-drop-${profile.id}`,
        data: dropData,
    });

    // Focus input when entering edit mode
    useEffect(() => {
        if (isEditingProfile && profileInputRef.current) {
            profileInputRef.current.focus();
            profileInputRef.current.select();
        }
    }, [isEditingProfile]);

    const handleProfileDoubleClick = (e) => {
        e.stopPropagation();
        setEditProfileValue(profile.name);
        setIsEditingProfile(true);
    };

    const handleProfileSave = async () => {
        if (editProfileValue.trim() && editProfileValue !== profile.name) {
            try {
                await API.updateChannelProfile({ id: profile.id, name: editProfileValue.trim() });
                await fetchChannelProfiles();
                await fetchChannelGroups();
            } catch (error) {
                console.error('Failed to rename profile:', error);
                setEditProfileValue(profile.name);
            }
        }
        setIsEditingProfile(false);
    };

    const handleProfileCancel = () => {
        setEditProfileValue(profile.name);
        setIsEditingProfile(false);
    };

    const handleProfileKeyDown = (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            handleProfileSave();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            handleProfileCancel();
        }
    };

    // Filter groups by search within this profile
    const filteredGroups = useMemo(() => {
        if (!searchQuery) return groups;
        const q = searchQuery.toLowerCase();
        return groups.filter((g) => (g?.name || '').toLowerCase().includes(q));
    }, [groups, searchQuery]);

    const groupIds = useMemo(() => groups.map((g) => `group-${g.id}`), [groups]);

    return (
        <Box mb={2} ref={setNodeRef}>
            {/* Profile header */}
            <Group
                gap={6}
                px="xs"
                py={6}
                style={{
                    borderRadius: 6,
                    backgroundColor: isOver
                        ? 'var(--mantine-color-blue-filled)'
                        : isExpanded
                            ? 'var(--mantine-color-dark-5)'
                            : 'transparent',
                    color: isOver ? 'white' : 'inherit',
                    transition: 'all 0.15s ease',
                }}
                className="group-item-hover"
                wrap="nowrap"
            >
                <ActionIcon
                    size="sm"
                    variant="subtle"
                    onClick={() => onToggle(profile.id)}
                    style={{ flexShrink: 0 }}
                >
                    {isExpanded ? (
                        <IconChevronDown size={14} />
                    ) : (
                        <IconChevronRight size={14} />
                    )}
                </ActionIcon>

                <IconUsers
                    size={15}
                    style={{ color: isOver ? 'white' : 'var(--mantine-color-violet-5)', flexShrink: 0 }}
                />

                {isEditingProfile ? (
                    <TextInput
                        ref={profileInputRef}
                        value={editProfileValue}
                        onChange={(e) => setEditProfileValue(e.target.value)}
                        onKeyDown={handleProfileKeyDown}
                        onBlur={handleProfileSave}
                        onClick={(e) => e.stopPropagation()}
                        size="sm"
                        style={{ flex: 1, minWidth: 0 }}
                        styles={{
                            input: {
                                minHeight: 24,
                                height: 24,
                                fontSize: 'var(--mantine-font-size-sm)',
                                fontWeight: 600,
                                padding: '0 6px',
                            }
                        }}
                    />
                ) : (
                    <Text
                        size="sm"
                        fw={600}
                        style={{ flex: 1, minWidth: 0 }}
                        truncate
                        onDoubleClick={handleProfileDoubleClick}
                    >
                        {profile.name}
                    </Text>
                )}

                <Tooltip label={`${totalGroups} ${totalGroups === 1 ? 'group' : 'groups'}`} withArrow position="top">
                    <Badge
                        size="xs"
                        variant={isOver ? 'white' : 'light'}
                        color={isOver ? 'blue' : (totalGroups > 0 ? 'teal' : 'gray')}
                        style={{ flexShrink: 0 }}
                    >
                        {totalGroups}
                    </Badge>
                </Tooltip>

                <Tooltip label={`${totalChannels} total ${totalChannels === 1 ? 'channel' : 'channels'} across groups`} withArrow position="top">
                    <Badge
                        size="xs"
                        variant={isOver ? 'white' : 'light'}
                        color={isOver ? 'blue' : (totalChannels > 0 ? 'violet' : 'gray')}
                        style={{ flexShrink: 0 }}
                    >
                        {totalChannels}
                    </Badge>
                </Tooltip>


                <Menu position="bottom-end" withinPortal>
                    <Menu.Target>
                        <ActionIcon
                            size="xs"
                            variant="subtle"
                            onClick={(e) => e.stopPropagation()}
                            className="row-action-btn"
                            c={isOver ? 'white' : undefined}
                        >
                            <IconDots size={12} />
                        </ActionIcon>
                    </Menu.Target>
                    <Menu.Dropdown>
                        <Menu.Item
                            leftSection={<IconEdit size={14} />}
                            onClick={(e) => { e.stopPropagation(); onRenameProfile(profile); }}
                        >
                            Rename
                        </Menu.Item>
                        <Menu.Item
                            leftSection={<IconWand size={14} />}
                            onClick={(e) => {
                                e.stopPropagation();
                                onMatchEpg?.([], { profileId: profile.id, scopeLabel: `all channels in profile "${profile.name}"` });
                            }}
                        >
                            Auto-Match EPG
                        </Menu.Item>
                        <Menu.Item
                            leftSection={<IconArrowsShuffle size={14} />}
                            onClick={(e) => {
                                e.stopPropagation();
                                onRemapChannels?.({ profileId: profile.id, scopeLabel: `profile "${profile.name}"` });
                            }}
                        >
                            Remap Channels
                        </Menu.Item>
                        <Menu.Divider />
                        <Menu.Item
                            leftSection={<IconTrash size={14} />}
                            color="red"
                            onClick={(e) => { e.stopPropagation(); onDeleteProfile(profile); }}
                        >
                            Delete
                        </Menu.Item>
                    </Menu.Dropdown>
                </Menu>
            </Group>

            {/* Nested groups */}
            <Collapse in={isExpanded}>
                <Box pl="md" py={2}>
                    <SortableContext items={groupIds} strategy={verticalListSortingStrategy}>
                        {filteredGroups.length > 0 ? (
                            filteredGroups.map((group) => (
                                <GroupItem
                                    key={group.id}
                                    group={group}
                                    isSelected={selectedGroup?.id === group.id}
                                    onSelect={onSelectGroup}
                                    profileId={profile.id}
                                    onRename={onRenameGroup}
                                    onDelete={onDeleteGroup}
                                    onDuplicate={onDuplicateGroup}
                                    onMatchEpg={onMatchEpg}
                                    onRemapChannels={onRemapChannels}
                                    fetchChannelGroups={fetchChannelGroups}
                                    fetchChannelProfiles={fetchChannelProfiles}
                                />
                            ))
                        ) : (
                            <Text size="xs" c="dimmed" py={4} pl={38}>
                                {searchQuery
                                    ? 'No matching groups'
                                    : 'No groups yet'}
                            </Text>
                        )}
                    </SortableContext>

                    {/* Add group row – styled like a GroupItem */}
                    <InlineAddPopover
                        tooltipLabel="Add Group"
                        placeholder="Group Name"
                        onSubmit={(name) => onAddGroup(profile.id, name)}
                        color="blue"
                    >
                        <Group
                            gap="xs"
                            p="4px 8px"
                            style={{
                                borderRadius: 6,
                                marginLeft: 4,
                                transition: 'background-color 0.15s ease',
                            }}
                            className="group-item-hover"
                        >
                            {/* Spacer to match GroupItem's drag handle */}
                            <Box style={{ width: 14 }} />

                            <Box style={{ width: 16, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                <IconPlus size={14} style={{ color: 'var(--mantine-color-blue-5)' }} />
                            </Box>
                            <Text size="xs" c="dimmed" fw={500}>
                                Add Group
                            </Text>
                        </Group>
                    </InlineAddPopover>
                </Box>
            </Collapse>
        </Box>
    );
});

/* ─── Main panel: always shows profiles → groups tree ─── */
const GroupsExplorerPanel = ({ selectedGroup, onSelectGroup, onMatchEpg, onRemapChannels }) => {
    const channelGroups = useChannelsStore((s) => s.channelGroups);
    const profiles = useChannelsStore((s) => s.profiles);
    const fetchChannelGroups = useChannelsStore((s) => s.fetchChannelGroups);
    const fetchChannelProfiles = useChannelsStore((s) => s.fetchChannelProfiles);
    const [searchQuery, setSearchQuery] = useState('');
    const debouncedSearch = useDebounce(searchQuery, 300);
    const [expandedProfiles, setExpandedProfiles] = useState({});

    // Mutation states
    const [renameModal, setRenameModal] = useState({ open: false, type: null, target: null, name: '' });
    const [deleteModal, setDeleteModal] = useState({ open: false, type: null, target: null });
    const [isMutating, setIsMutating] = useState(false);
    const [createProfileModalOpen, setCreateProfileModalOpen] = useState(false);

    useEffect(() => {
        fetchChannelGroups();
        fetchChannelProfiles();
    }, []);

    // Auto-expand profiles on first load
    useEffect(() => {
        const profileIds = Object.keys(profiles).filter((id) => id !== '0');
        if (profileIds.length > 0 && Object.keys(expandedProfiles).length === 0) {
            const expanded = {};
            profileIds.forEach((id) => { expanded[id] = true; });
            setExpandedProfiles(expanded);
        }
    }, [profiles]);

    // Real profiles (exclude the synthetic "All" id = 0)
    const realProfiles = useMemo(
        () => Object.values(profiles).filter((p) => String(p.id) !== '0'),
        [profiles]
    );

    // Filter profiles by search
    const filteredProfiles = useMemo(() => {
        if (!debouncedSearch) return realProfiles;
        const q = debouncedSearch.toLowerCase();
        // Show profile if its name matches OR any of its groups match
        return realProfiles.filter((p) => {
            if ((p.name || '').toLowerCase().includes(q)) return true;
            // Check if any group in profile matches
            const allGroups = Object.values(channelGroups);
            if (p.profile_groups) {
                return p.profile_groups.some((pg) => {
                    const g = channelGroups[pg.channel_group_id];
                    return g && (g.name || '').toLowerCase().includes(q);
                });
            }
            return false;
        });
    }, [realProfiles, debouncedSearch, channelGroups]);

    // Get groups for a specific profile
    const getProfileGroups = useCallback(
        (profileId) => {
            const profile = profiles[profileId];
            if (!profile?.profile_groups || !Array.isArray(profile.profile_groups)) return [];

            return profile.profile_groups.map((pg) => {
                const baseGroup = channelGroups[pg.channel_group_id] || {
                    id: pg.channel_group_id,
                    name: pg.channel_group_name || 'Unnamed Group',
                };
                return {
                    ...baseGroup,
                    // Use the profile-specific count if available, otherwise fallback to global
                    channel_count: pg.channel_count !== undefined ? pg.channel_count : (baseGroup.channel_count || 0),
                    order: pg.order,
                    is_active: pg.is_active !== undefined ? pg.is_active : true, // Include is_active from ProfileGroup
                };
            }).sort((a, b) => {
                const orderA = a.order ?? 999;
                const orderB = b.order ?? 999;
                if (orderA !== orderB) return orderA - orderB;
                return (a.name || '').localeCompare(b.name || '');
            });
        },
        [profiles, channelGroups]
    );

    const toggleProfile = useCallback((profileId) => {
        setExpandedProfiles((prev) => ({
            ...prev,
            [profileId]: !prev[profileId],
        }));
    }, []);

    const handleAddProfile = useCallback(async (name) => {
        await API.addChannelProfile({ name });
    }, []);

    const handleAddGroup = useCallback(
        async (profileId, name) => {
            const result = await API.addProfileGroup(profileId, { name });
            if (result && result.channel_group) {
                await fetchChannelProfiles();
                await fetchChannelGroups();

                // Get the group ID from the response
                const groupId = typeof result.channel_group === 'object'
                    ? result.channel_group.id
                    : result.channel_group;

                // Access the fresh state directly from the store after fetching
                const freshGroups = useChannelsStore.getState().channelGroups;
                const newGroup = freshGroups[groupId];

                if (newGroup) {
                    onSelectGroup(newGroup);
                } else {
                    console.warn('Group not found in store after creation:', groupId);
                }
            }
        },
        [fetchChannelProfiles, fetchChannelGroups, onSelectGroup]
    );

    const handleDuplicateGroup = useCallback(async (group, profileId) => {
        // Find all groups in the current profile
        const profileGroups = getProfileGroups(profileId);
        const exists = (name) => profileGroups.some(g => g.name === name);

        let newName = `${group.name} (Copy)`;
        let counter = 1;
        while (exists(newName)) {
            newName = `${group.name} (Copy ${++counter})`;
        }

        const result = await API.addProfileGroup(profileId, { name: newName, duplicate_from_id: group.id });
        if (result) {
            await fetchChannelProfiles();
            await fetchChannelGroups();

            // Automatically select the newly duplicated group
            if (result.channel_group) {
                onSelectGroup(result.channel_group);
            }
        }
    }, [getProfileGroups, fetchChannelProfiles, fetchChannelGroups, onSelectGroup]);

    const executeRename = async () => {
        const { type, target, name } = renameModal;
        if (!name.trim()) return;
        setIsMutating(true);
        try {
            if (type === 'group') {
                await API.updateChannelGroup({ id: target.id, name });
            } else if (type === 'profile') {
                await API.updateChannelProfile({ id: target.id, name });
            }
            await fetchChannelProfiles();
            await fetchChannelGroups();
            setRenameModal({ open: false, type: null, target: null, name: '' });
        } catch (e) {
            console.error('Rename failed:', e);
        } finally {
            setIsMutating(false);
        }
    };

    const executeDelete = async () => {
        const { type, target } = deleteModal;
        setIsMutating(true);
        try {
            if (type === 'group') {
                // If the group is selected, unselect it
                if (selectedGroup?.id === target.id) {
                    onSelectGroup(null);
                }
                await API.deleteChannelGroup(target.id);
            } else if (type === 'profile') {
                await API.deleteChannelProfile(target.id);
            }
            await fetchChannelProfiles();
            await fetchChannelGroups();
            setDeleteModal({ open: false, type: null, target: null });
        } catch (e) {
            console.error('Delete failed:', e);
        } finally {
            setIsMutating(false);
        }
    };

    return (
        <Box h="100%" display="flex" style={{ flexDirection: 'column' }}>
            {/* Header */}
            <Box
                p="sm"
                style={{ borderBottom: '1px solid var(--mantine-color-dark-4)' }}
            >
                <Stack gap="xs">
                    <Group justify="space-between">
                        <Text fw={600} size="md">
                            Profiles
                        </Text>
                        <Tooltip label="Create Profile">
                            <ActionIcon
                                size="sm"
                                variant="light"
                                color="green"
                                onClick={() => setCreateProfileModalOpen(true)}
                            >
                                <IconPlus size={14} />
                            </ActionIcon>
                        </Tooltip>
                    </Group>
                    <TextInput
                        placeholder="Search..."
                        leftSection={<IconSearch size={14} />}
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        size="xs"
                    />
                </Stack>
            </Box>

            {/* Rename Modal */}
            <Modal
                opened={renameModal.open}
                onClose={() => setRenameModal({ open: false, type: null, target: null, name: '' })}
                title={`Rename ${renameModal.type === 'group' ? 'Group' : 'Profile'}`}
                size="sm"
            >
                <Stack>
                    <TextInput
                        label="New Name"
                        value={renameModal.name}
                        onChange={(e) => setRenameModal(prev => ({ ...prev, name: e.target.value }))}
                        data-autofocus
                        onKeyDown={(e) => { if (e.key === 'Enter') executeRename(); }}
                    />
                    <Group justify="flex-end">
                        <Button variant="light" onClick={() => setRenameModal({ open: false, type: null, target: null, name: '' })}>Cancel</Button>
                        <Button loading={isMutating} onClick={executeRename}>Save</Button>
                    </Group>
                </Stack>
            </Modal>

            {/* Delete Confirmation */}
            <ConfirmationDialog
                opened={deleteModal.open}
                onClose={() => setDeleteModal({ open: false, type: null, target: null })}
                onConfirm={executeDelete}
                title={`Delete ${deleteModal.type === 'group' ? 'Group' : 'Profile'}`}
                message={
                    deleteModal.type === 'group'
                        ? `Are you sure you want to delete the group "${deleteModal.target?.name}"? This will also delete all ${deleteModal.target?.channel_count || 0} channels in this group. This cannot be undone.`
                        : `Are you sure you want to delete the profile "${deleteModal.target?.name}"? This will permanently remove the profile and its group associations, but won't delete the channels themselves. This cannot be undone.`
                }
                confirmLabel="Delete"
                confirmColor="red"
                loading={isMutating}
            />

            {/* Create Profile Modal */}
            <CreateProfileModal
                opened={createProfileModalOpen}
                onClose={() => setCreateProfileModalOpen(false)}
            />

            {/* Profile → Group tree */}
            <ScrollArea style={{ flex: 1 }} scrollbarSize={6}>
                <Box p="xs">
                    {filteredProfiles.length > 0 ? (
                        filteredProfiles.map((profile) => (
                            <ProfileSection
                                key={profile.id}
                                profile={profile}
                                groups={getProfileGroups(profile.id)}
                                isExpanded={!!expandedProfiles[profile.id]}
                                onToggle={toggleProfile}
                                selectedGroup={selectedGroup}
                                onSelectGroup={onSelectGroup}
                                onAddGroup={handleAddGroup}
                                searchQuery={debouncedSearch}
                                onRenameGroup={(g) => setRenameModal({ open: true, type: 'group', target: g, name: g.name })}
                                onDeleteGroup={(g) => setDeleteModal({ open: true, type: 'group', target: g })}
                                onDuplicateGroup={handleDuplicateGroup}
                                onRenameProfile={(p) => setRenameModal({ open: true, type: 'profile', target: p, name: p.name })}
                                onDeleteProfile={(p) => setDeleteModal({ open: true, type: 'profile', target: p })}
                                onMatchEpg={onMatchEpg}
                                onRemapChannels={onRemapChannels}
                                fetchChannelGroups={fetchChannelGroups}
                                fetchChannelProfiles={fetchChannelProfiles}
                            />
                        ))
                    ) : (
                        <Box p="xl" style={{ textAlign: 'center' }}>
                            <Text c="dimmed" size="sm" mb="xs">
                                {searchQuery
                                    ? 'No matching profiles or groups'
                                    : 'No profiles yet'}
                            </Text>
                            {!searchQuery && (
                                <Text c="dimmed" size="xs">
                                    Click the + button above to create your first profile
                                </Text>
                            )}
                        </Box>
                    )}
                </Box>
            </ScrollArea>

            {/* Video Preview Panel at the bottom */}
            <VideoPreviewPanel />
        </Box>
    );
};

export default GroupsExplorerPanel;
