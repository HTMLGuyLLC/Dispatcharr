import React, { useState, useEffect, useMemo } from 'react';
import {
    Modal,
    Select,
    Button,
    Stack,
    Text,
    Group,
    Alert,
    Table,
    ScrollArea,
    Badge,
    Loader,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconArrowsShuffle, IconAlertCircle, IconCheck } from '@tabler/icons-react';
import API from '../../api';

const RemapChannelsModal = ({ opened, onClose, scope, onSuccess }) => {
    const [sources, setSources] = useState([]);
    const [loading, setLoading] = useState(false);
    const [loadingSources, setLoadingSources] = useState(false);
    const [sourceValue, setSourceValue] = useState(null);
    const [destValue, setDestValue] = useState(null);
    const [result, setResult] = useState(null);

    // Load M3U + Xtream accounts when the modal opens
    useEffect(() => {
        if (!opened) {
            // Reset state when modal closes
            setSourceValue(null);
            setDestValue(null);
            setResult(null);
            return;
        }

        const loadSources = async () => {
            setLoadingSources(true);
            try {
                const [playlists, xtreamAccounts] = await Promise.all([
                    API.getPlaylists(),
                    API.getXtreamAccounts(),
                ]);

                const items = [];

                // Add M3U accounts
                if (Array.isArray(playlists)) {
                    for (const p of playlists) {
                        items.push({
                            value: `m3u:${p.id}`,
                            label: p.name,
                            group: 'M3U Accounts',
                        });
                    }
                }

                // Add Xtream accounts - handle both array and paginated response
                const xtreamList = Array.isArray(xtreamAccounts)
                    ? xtreamAccounts
                    : xtreamAccounts?.results || [];
                for (const x of xtreamList) {
                    items.push({
                        value: `xtream:${x.id}`,
                        label: x.name,
                        group: 'Xtream Accounts',
                    });
                }

                setSources(items);
            } catch (err) {
                console.error('Failed to load sources:', err);
            } finally {
                setLoadingSources(false);
            }
        };

        loadSources();
    }, [opened]);

    const parseSourceValue = (val) => {
        if (!val) return { type: null, id: null };
        const [type, id] = val.split(':');
        return { type, id: parseInt(id, 10) };
    };

    const handleGo = async () => {
        const src = parseSourceValue(sourceValue);
        const dst = parseSourceValue(destValue);

        if (!src.type || !dst.type) return;

        setLoading(true);
        setResult(null);

        try {
            const response = await API.remapChannels({
                sourceType: src.type,
                sourceId: src.id,
                destType: dst.type,
                destId: dst.id,
                channelGroupId: scope?.channelGroupId || null,
                profileId: scope?.profileId || null,
            });

            setResult(response);

            if (response.remapped_count > 0) {
                notifications.show({
                    title: 'Remap Complete',
                    message: `Successfully remapped ${response.remapped_count} channel stream(s).`,
                    color: 'green',
                    icon: <IconCheck size={16} />,
                });
            }

            onSuccess?.();
        } catch (err) {
            console.error('Remap failed:', err);
        } finally {
            setLoading(false);
        }
    };

    const scopeLabel = scope?.scopeLabel || 'selected channels';

    const canGo = sourceValue && destValue && sourceValue !== destValue && !loading;

    return (
        <Modal
            opened={opened}
            onClose={onClose}
            title={
                <Group gap="xs">
                    <IconArrowsShuffle size={20} />
                    <Text fw={600}>Remap Channels</Text>
                </Group>
            }
            size="lg"
            centered
        >
            <Stack gap="md">
                <Text size="sm" c="dimmed">
                    Swap all channel streams from one source to another for {scopeLabel}.
                    Channels are matched by <strong>tvg_id</strong>.
                </Text>

                <Select
                    label="Source"
                    placeholder={loadingSources ? 'Loading...' : 'Select source account'}
                    data={sources}
                    value={sourceValue}
                    onChange={setSourceValue}
                    searchable
                    disabled={loadingSources || loading}
                    rightSection={loadingSources ? <Loader size={14} /> : undefined}
                />

                <Select
                    label="Destination"
                    placeholder={loadingSources ? 'Loading...' : 'Select destination account'}
                    data={sources}
                    value={destValue}
                    onChange={setDestValue}
                    searchable
                    disabled={loadingSources || loading}
                    rightSection={loadingSources ? <Loader size={14} /> : undefined}
                />

                <Group justify="flex-end">
                    <Button variant="default" onClick={onClose} disabled={loading}>
                        Cancel
                    </Button>
                    <Button
                        onClick={handleGo}
                        loading={loading}
                        disabled={!canGo}
                        leftSection={<IconArrowsShuffle size={16} />}
                    >
                        Go
                    </Button>
                </Group>

                {/* Results */}
                {result && (
                    <Stack gap="sm">
                        <Alert
                            icon={result.errors?.length > 0 ? <IconAlertCircle size={16} /> : <IconCheck size={16} />}
                            color={result.errors?.length > 0 ? 'yellow' : 'green'}
                            title={`Remapped ${result.remapped_count} stream(s)`}
                        >
                            {result.errors?.length > 0
                                ? `${result.errors.length} channel(s) could not be remapped.`
                                : 'All channels were successfully remapped.'}
                        </Alert>

                        {result.errors?.length > 0 && (
                            <ScrollArea.Autosize mah={300}>
                                <Table
                                    striped
                                    highlightOnHover
                                    withTableBorder
                                    withColumnBorders
                                    fz="xs"
                                >
                                    <Table.Thead>
                                        <Table.Tr>
                                            <Table.Th>Channel</Table.Th>
                                            <Table.Th>TVG ID</Table.Th>
                                            <Table.Th>Reason</Table.Th>
                                        </Table.Tr>
                                    </Table.Thead>
                                    <Table.Tbody>
                                        {result.errors.map((err, i) => (
                                            <Table.Tr key={i}>
                                                <Table.Td>{err.channel_name}</Table.Td>
                                                <Table.Td>
                                                    <Badge size="xs" variant="light" color="gray">
                                                        {err.tvg_id || '—'}
                                                    </Badge>
                                                </Table.Td>
                                                <Table.Td>
                                                    <Text size="xs" c="red">
                                                        {err.reason}
                                                    </Text>
                                                </Table.Td>
                                            </Table.Tr>
                                        ))}
                                    </Table.Tbody>
                                </Table>
                            </ScrollArea.Autosize>
                        )}
                    </Stack>
                )}
            </Stack>
        </Modal>
    );
};

export default RemapChannelsModal;
