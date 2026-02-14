import React, { useState } from 'react';
import {
    Modal,
    NumberInput,
    MultiSelect,
    Button,
    Stack,
    Group,
    Flex,
    Text,
    Switch,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { USER_LEVELS } from '../../constants';
import API from '../../api';
import useAuthStore from '../../store/auth';
import useChannelsStore from '../../store/channels';

const UserBulkGenerate = ({ isOpen, onClose }) => {
    const [isLoading, setIsLoading] = useState(false);
    const authUser = useAuthStore((s) => s.user);
    const channelProfiles = useChannelsStore((s) => s.profiles);

    const form = useForm({
        initialValues: {
            count: 10,
            password_length: 8,
            connection_limit: 1,
            expires_in_days: 0,
            channel_profile_ids: [],
            exclude_mature: false,
        },
        validate: {
            count: (value) => (value < 1 ? 'Count must be at least 1' : null),
            password_length: (value) => (value < 4 ? 'Password must be at least 4 chars' : null),
        },
    });

    const onSubmit = async (values) => {
        setIsLoading(true);
        try {
            const payload = {
                ...values,
                count: parseInt(values.count),
                password_length: parseInt(values.password_length),
                connection_limit: parseInt(values.connection_limit),
                expires_in_days: parseInt(values.expires_in_days),
                user_level: USER_LEVELS.STREAMER, // Always create streamers
                channel_profile_ids: values.channel_profile_ids.map(id => parseInt(id)),
            };

            await API.bulkGenerateUsers(payload);
            onClose();
        } catch (error) {
            console.error('Bulk generate failed:', error);
        } finally {
            setIsLoading(false);
        }
    };

    const profileOptions = channelProfiles
        ? Object.values(channelProfiles).map((profile) => ({
            label: profile.name,
            value: `${profile.id}`,
        }))
        : [];

    return (
        <Modal opened={isOpen} onClose={onClose} title="Bulk Generate Streamers" size="md">
            <form onSubmit={form.onSubmit(onSubmit)}>
                <Stack>
                    <Group grow>
                        <NumberInput
                            label="Streamer Count"
                            description="Number of streamers to create"
                            min={1}
                            max={100}
                            {...form.getInputProps('count')}
                        />
                        <NumberInput
                            label="Password Length"
                            description="Length of generated passwords"
                            min={4}
                            max={32}
                            {...form.getInputProps('password_length')}
                        />
                    </Group>

                    <Group grow>
                        <NumberInput
                            label="Connection Limit"
                            description="Max concurrent connections"
                            min={1}
                            {...form.getInputProps('connection_limit')}
                        />
                        <NumberInput
                            label="Expires In (Days)"
                            description="0 for no expiration"
                            min={0}
                            {...form.getInputProps('expires_in_days')}
                        />
                    </Group>

                    <MultiSelect
                        label="Channel Profiles"
                        description="Assign streamers to specific profiles (optional)"
                        placeholder="Select profiles"
                        data={profileOptions}
                        clearable
                        searchable
                        {...form.getInputProps('channel_profile_ids')}
                    />

                    <Switch
                        label="Exclude Mature Content"
                        description="Filter out adult/mature content channels"
                        {...form.getInputProps('exclude_mature', { type: 'checkbox' })}
                    />

                    <Text size="xs" c="dimmed">
                        Note: Usernames and passwords will be randomly generated.
                    </Text>

                    <Flex justify="flex-end" mt="md">
                        <Button
                            type="submit"
                            loading={isLoading}
                        >
                            Generate Streamers
                        </Button>
                    </Flex>
                </Stack>
            </form>
        </Modal>
    );
};

export default UserBulkGenerate;
