import React, { useState } from 'react';
import {
    ActionIcon,
    Group,
    Popover,
    TextInput,
    Tooltip,
    useMantineTheme,
} from '@mantine/core';
import { CircleCheck, SquarePlus } from 'lucide-react';

/**
 * Reusable inline popover for adding items by name.
 * Matches the pattern used in ChannelTableHeader's CreateProfilePopover.
 */
const InlineAddPopover = ({
    tooltipLabel = 'Add',
    placeholder = 'Name',
    onSubmit,
    iconSize = 20,
    color,
    disabled = false,
    icon: Icon = SquarePlus,
    children,
}) => {
    const [opened, setOpened] = useState(false);
    const [name, setName] = useState('');
    const theme = useMantineTheme();
    const iconColor = color || theme.tailwind?.green?.[5] || 'green.5';

    const toggle = () => {
        setName('');
        setOpened(!opened);
    };

    const submit = async () => {
        if (!name.trim()) return;
        await onSubmit(name.trim());
        setName('');
        setOpened(false);
    };

    const handleKeyDown = (e) => {
        if (e.key === 'Enter') submit();
        if (e.key === 'Escape') {
            setName('');
            setOpened(false);
        }
    };

    return (
        <Popover
            opened={opened}
            onChange={toggle}
            position="bottom"
            withArrow
            shadow="md"
        >
            <Popover.Target>
                {children ? (
                    <div onClick={toggle} style={{ cursor: 'pointer' }}>
                        {children}
                    </div>
                ) : (
                    <Tooltip label={tooltipLabel} disabled={opened}>
                        <ActionIcon
                            variant="transparent"
                            color={iconColor}
                            onClick={toggle}
                            disabled={disabled}
                            size="sm"
                        >
                            <Icon size={iconSize} />
                        </ActionIcon>
                    </Tooltip>
                )}
            </Popover.Target>

            <Popover.Dropdown>
                <Group gap="xs">
                    <TextInput
                        placeholder={placeholder}
                        value={name}
                        onChange={(e) => setName(e.currentTarget.value)}
                        onKeyDown={handleKeyDown}
                        size="xs"
                        autoFocus
                        style={{ flex: 1 }}
                    />
                    <ActionIcon
                        variant="transparent"
                        color={iconColor}
                        size="sm"
                        onClick={submit}
                        disabled={!name.trim()}
                    >
                        <CircleCheck size={18} />
                    </ActionIcon>
                </Group>
            </Popover.Dropdown>
        </Popover>
    );
};

export default InlineAddPopover;
