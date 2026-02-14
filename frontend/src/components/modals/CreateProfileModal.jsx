import React, { useState, useEffect } from 'react';
import {
    Alert,
    Box,
    Button,
    Checkbox,
    Group,
    Modal,
    MultiSelect,
    Stack,
    Text,
    TextInput,
} from '@mantine/core';
import { Info } from 'lucide-react';
import API from '../../api';
import { notifications } from '@mantine/notifications';
import useChannelsStore from '../../store/channels';
import usePlaylistsStore from '../../store/playlists';

const CreateProfileModal = ({ opened, onClose }) => {
    const [profileName, setProfileName] = useState('');
    const [selectedSources, setSelectedSources] = useState([]);
    const [includeChannels, setIncludeChannels] = useState(false);
    const [isSubmitting, setIsSubmitting] = useState(false);

    const playlists = usePlaylistsStore((s) => s.playlists);
    const channelGroups = useChannelsStore((s) => s.channelGroups);
    const setSelectedProfileId = useChannelsStore((s) => s.setSelectedProfileId);

    // Reset form when modal closes
    useEffect(() => {
        if (!opened) {
            setProfileName('');
            setSelectedSources([]);
            setIncludeChannels(false);
        }
    }, [opened]);

    // Prepare M3U source options for multiselect
    const sourceOptions = playlists.map((playlist) => ({
        value: `${playlist.id}`,
        label: playlist.name,
        // Show how many groups this source has
        description: `${playlist.channel_groups?.length || 0} groups`,
    }));

    const handleSubmit = async () => {
        const trimmedName = profileName.trim();

        if (!trimmedName) {
            notifications.show({
                title: 'Profile name is required',
                color: 'red.5',
            });
            return;
        }

        setIsSubmitting(true);

        try {
            // If sources are selected, use the new optimized backend endpoint
            if (selectedSources.length > 0) {
                console.log('[CreateProfile] Using optimized backend endpoint for sources:', selectedSources);

                // Convert source IDs to integers
                const sourceIds = selectedSources.map(id => parseInt(id, 10));

                // Trigger the async task
                const response = await API.createChannelProfileFromSource(
                    trimmedName,
                    sourceIds,
                    includeChannels
                );

                if (response) {
                    notifications.show({
                        title: 'Profile creation started',
                        message: 'Creating profile in the background. You will be notified when complete.',
                        color: 'blue.5',
                        autoClose: 5000,
                    });

                    onClose();
                }
            } else {
                // No sources selected - create empty profile using the original endpoint
                console.log('[CreateProfile] Creating empty profile');

                const payload = {
                    name: trimmedName,
                };

                const newProfile = await API.addChannelProfile(payload);

                if (newProfile) {
                    notifications.show({
                        title: 'Profile created',
                        message: 'Empty profile created',
                        color: 'green.5',
                        autoClose: 3000,
                    });

                    // Switch to the newly created profile
                    setSelectedProfileId(`${newProfile.id}`);
                    onClose();
                }
            }
        } catch (error) {
            console.error('Failed to create profile:', error);
            notifications.show({
                title: 'Failed to create profile',
                message: error.message || 'An error occurred',
                color: 'red.5',
            });
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <Modal
            opened={opened}
            onClose={onClose}
            title="Create New Profile"
            centered
            size="md"
        >
            <Stack gap="md">
                <TextInput
                    label="Profile name"
                    placeholder="Enter profile name"
                    value={profileName}
                    onChange={(event) => setProfileName(event.currentTarget.value)}
                    data-autofocus
                    required
                />

                <Box>
                    <MultiSelect
                        label="Clone groups from M3U sources (optional)"
                        placeholder="Select M3U sources"
                        description="Select one or more M3U sources to copy their groups into this profile"
                        data={sourceOptions}
                        value={selectedSources}
                        onChange={setSelectedSources}
                        searchable
                        clearable
                    />
                </Box>

                {selectedSources.length > 0 && (
                    <>
                        <Checkbox
                            label="Include channels from selected groups"
                            description="If checked, channels will be copied along with the groups. If unchecked, only the group structure will be created (empty groups)."
                            checked={includeChannels}
                            onChange={(event) => setIncludeChannels(event.currentTarget.checked)}
                        />

                        <Alert icon={<Info size={16} />} color="blue" variant="light">
                            <Text size="sm">
                                {includeChannels ? (
                                    <>
                                        This will create a <strong>fully populated profile</strong> with all groups and channels from the selected sources.
                                    </>
                                ) : (
                                    <>
                                        This will create a profile with <strong>group structure only</strong>. You can manually add channels later.
                                    </>
                                )}
                            </Text>
                        </Alert>
                    </>
                )}

                {selectedSources.length === 0 && (
                    <Alert icon={<Info size={16} />} color="gray" variant="light">
                        <Text size="sm">
                            Leave sources empty to create a <strong>blank profile</strong> that you can configure manually.
                        </Text>
                    </Alert>
                )}

                <Group justify="flex-end" gap="xs">
                    <Button variant="default" size="xs" onClick={onClose} disabled={isSubmitting}>
                        Cancel
                    </Button>
                    <Button size="xs" onClick={handleSubmit} loading={isSubmitting}>
                        Create Profile
                    </Button>
                </Group>
            </Stack>
        </Modal>
    );
};

export default CreateProfileModal;
