import React, { useMemo, useCallback, useState } from 'react';
import API from '../../api';
import UserForm from '../forms/User';
import useUsersStore from '../../store/users';
import useAuthStore from '../../store/auth';
import useChannelsStore from '../../store/channels';
import { USER_LEVELS, USER_LEVEL_LABELS } from '../../constants';
import useWarningsStore from '../../store/warnings';
import { SquarePlus, SquareMinus, SquarePen, Eye, EyeOff, Users, Copy } from 'lucide-react';
import UserBulkGenerate from '../forms/UserBulkGenerate';
import useSettingsStore from '../../store/settings';
import {
  ActionIcon,
  Box,
  Text,
  Paper,
  Button,
  Flex,
  Group,
  useMantineTheme,
  LoadingOverlay,
  Stack,
} from '@mantine/core';
import { CustomTable, useTable } from './CustomTable';
import ConfirmationDialog from '../ConfirmationDialog';
import useLocalStorage from '../../hooks/useLocalStorage';
import { useDateTimeFormat, format } from '../../utils/dateTimeUtils.js';
import { notifications } from '@mantine/notifications';
import dayjs from 'dayjs';

const UserRowActions = ({ theme, row, editUser, deleteUser, copyCredentials }) => {
  const [tableSize, _] = useLocalStorage('table-size', 'default');
  const authUser = useAuthStore((s) => s.user);

  const onEdit = useCallback(() => {
    editUser(row.original);
  }, [row.original, editUser]);

  const onDelete = useCallback(() => {
    deleteUser(row.original.id);
  }, [row.original.id, deleteUser]);

  const onCopy = useCallback(() => {
    copyCredentials(row.original);
  }, [row.original, copyCredentials]);

  const iconSize =
    tableSize == 'default' ? 'sm' : tableSize == 'compact' ? 'xs' : 'md';

  return (
    <Box style={{ width: '100%', justifyContent: 'left' }}>
      <Group gap={2} justify="center">
        <ActionIcon
          size={iconSize}
          variant="transparent"
          color={theme.tailwind.blue[4]}
          onClick={onCopy}
          title="Copy Credentials"
        >
          <Copy size="18" />
        </ActionIcon>

        <ActionIcon
          size={iconSize}
          variant="transparent"
          color={theme.tailwind.yellow[3]}
          onClick={onEdit}
          disabled={authUser.user_level < USER_LEVELS.RESELLER}
        >
          <SquarePen size="18" />
        </ActionIcon>

        <ActionIcon
          size={iconSize}
          variant="transparent"
          color={theme.tailwind.red[6]}
          onClick={onDelete}
          disabled={
            authUser.user_level < USER_LEVELS.RESELLER ||
            authUser.id === row.original.id
          }
        >
          <SquareMinus size="18" />
        </ActionIcon>
      </Group>
    </Box>
  );
};

const UsersTable = () => {
  const theme = useMantineTheme();
  const { fullDateFormat, fullDateTimeFormat } = useDateTimeFormat();

  /**
   * STORES
   */
  const users = useUsersStore((s) => s.users);
  const authUser = useAuthStore((s) => s.user);
  const isWarningSuppressed = useWarningsStore((s) => s.isWarningSuppressed);
  const suppressWarning = useWarningsStore((s) => s.suppressWarning);
  const env_mode = useSettingsStore((s) => s.environment.env_mode);

  /**
   * useState
   */
  const [selectedUser, setSelectedUser] = useState(null);
  const [userModalOpen, setUserModalOpen] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [userToDelete, setUserToDelete] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [visiblePasswords, setVisiblePasswords] = useState({});
  const [bulkGenerateOpen, setBulkGenerateOpen] = useState(false);

  /**
   * Functions
   */
  const togglePasswordVisibility = useCallback((userId) => {
    setVisiblePasswords((prev) => ({
      ...prev,
      [userId]: !prev[userId],
    }));
  }, []);

  const executeDeleteUser = useCallback(async (id) => {
    setIsLoading(true);
    setDeleting(true);
    try {
      await API.deleteUser(id);
    } finally {
      setDeleting(false);
      setIsLoading(false);
      setConfirmDeleteOpen(false);
    }
  }, []);

  const editUser = useCallback(async (user = null) => {
    setSelectedUser(user);
    setUserModalOpen(true);
  }, []);

  const deleteUser = useCallback(
    async (id) => {
      const user = users.find((u) => u.id === id);
      setUserToDelete(user);
      setDeleteTarget(id);

      if (isWarningSuppressed('delete-user')) {
        return executeDeleteUser(id);
      }

      setConfirmDeleteOpen(true);
    },
    [users, isWarningSuppressed, executeDeleteUser]
  );

  const copyCredentials = useCallback((user) => {
    const hostname = window.location.hostname;
    const port = window.location.port;
    const protocol = window.location.protocol;

    // Only include port if it's not the default for the protocol
    let fullHostname = `${protocol}//${hostname}`;
    let effectivePort = port;
    if (env_mode === 'dev' && port === '9191') {
      effectivePort = '5656';
    }

    if (effectivePort && effectivePort !== '80' && effectivePort !== '443') {
      fullHostname += `:${effectivePort}`;
    }

    // Get profile names
    const profiles = useChannelsStore.getState().profiles;
    let profileNames = 'All Profiles';
    if (user.channel_profiles && user.channel_profiles.length > 0) {
      profileNames = user.channel_profiles
        .map(id => profiles[id]?.name)
        .filter(Boolean)
        .join(', ');
    }

    // Format expiration date
    let expirationText = 'Never';
    if (user.expires_at) {
      expirationText = dayjs(user.expires_at).format('MMMM D, YYYY [at] h:mm A');
    }

    // Get XC password from custom_properties
    const customProps = user.custom_properties || {};
    const xcPassword = customProps.xc_password || 'Not set';

    const credentialsText = `Here's your Xtream login details!

Hostname: ${fullHostname}
Username: ${user.username}
Password: ${xcPassword}
Connections: ${user.connection_limit || 1}
Expiration: ${expirationText}
Profile(s): ${profileNames}`;

    navigator.clipboard.writeText(credentialsText).then(() => {
      notifications.show({
        title: 'Credentials Copied!',
        message: `Credentials for ${user.username} copied to clipboard`,
        color: 'green',
      });
    }).catch(() => {
      notifications.show({
        title: 'Copy Failed',
        message: 'Failed to copy credentials to clipboard',
        color: 'red',
      });
    });
  }, []);

  /**
   * useMemo
   */
  const columns = useMemo(
    () => [
      {
        header: 'User Level',
        accessorKey: 'user_level',
        size: 120,
        cell: ({ getValue }) => (
          <Text size="sm">{USER_LEVEL_LABELS[getValue()]}</Text>
        ),
      },
      {
        header: 'Credits',
        accessorKey: 'credits',
        size: 80,
        cell: ({ getValue, row }) => {
          if (row.original.user_level !== USER_LEVELS.RESELLER) return '-';
          return <Text size="sm">{getValue() || 0}</Text>;
        },
      },
      {
        header: 'Username',
        accessorKey: 'username',
        size: 150,
        cell: ({ getValue }) => (
          <Box
            style={{
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {getValue()}
          </Box>
        ),
      },
      {
        id: 'name',
        header: 'Name',
        accessorFn: (row) =>
          `${row.first_name || ''} ${row.last_name || ''}`.trim(),
        cell: ({ getValue }) => (
          <Box
            style={{
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {getValue() || '-'}
          </Box>
        ),
      },
      {
        header: 'Email',
        accessorKey: 'email',
        grow: true,
        cell: ({ getValue }) => (
          <Box
            style={{
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {getValue()}
          </Box>
        ),
      },
      {
        header: 'Date Joined',
        accessorKey: 'date_joined',
        size: 125,
        cell: ({ getValue }) => {
          const date = getValue();
          return (
            <Text size="sm">{date ? format(date, fullDateFormat) : '-'}</Text>
          );
        },
      },
      {
        header: 'Last Login',
        accessorKey: 'last_login',
        size: 175,
        cell: ({ getValue }) => {
          const date = getValue();
          return (
            <Text size="sm">
              {date ? format(date, fullDateTimeFormat) : 'Never'}
            </Text>
          );
        },
      },
      {
        header: 'Conn. Limit',
        accessorKey: 'connection_limit',
        size: 100,
        cell: ({ getValue }) => <Text size="sm">{getValue() || 1}</Text>,
      },
      {
        header: 'Expires',
        accessorKey: 'expires_at',
        size: 175,
        cell: ({ getValue }) => {
          const date = getValue();
          if (!date)
            return (
              <Text size="sm" c="dimmed">
                Never
              </Text>
            );
          const isExpired = new Date(date) < new Date();
          return (
            <Text size="sm" c={isExpired ? 'red' : 'inherit'}>
              {format(date, fullDateTimeFormat)}
              {isExpired && ' (Expired)'}
            </Text>
          );
        },
      },
      {
        header: 'XC Password',
        accessorKey: 'custom_properties',
        size: 125,
        enableSorting: false,
        cell: ({ getValue, row }) => {
          const userId = row.original.id;
          const isVisible = visiblePasswords[userId];

          // Extract xc_password from custom_properties
          let password = 'N/A';
          const customProps = getValue() || {};
          password = customProps.xc_password || 'N/A';

          return (
            <Group gap={4} style={{ alignItems: 'center' }}>
              <Text
                size="sm"
                style={{ fontFamily: 'monospace', minWidth: '60px' }}
              >
                {password === 'N/A' ? 'N/A' : isVisible ? password : '••••••••'}
              </Text>
              {password !== 'N/A' && (
                <ActionIcon
                  size="xs"
                  variant="transparent"
                  color="gray"
                  onClick={() => togglePasswordVisibility(userId)}
                >
                  {isVisible ? <EyeOff size={12} /> : <Eye size={12} />}
                </ActionIcon>
              )}
            </Group>
          );
        },
      },
      {
        id: 'actions',
        size: 80,
        header: 'Actions',
        enableSorting: false,
        cell: ({ row }) => (
          <UserRowActions
            theme={theme}
            row={row}
            editUser={editUser}
            deleteUser={deleteUser}
            copyCredentials={copyCredentials}
          />
        ),
      },
    ],
    [
      theme,
      editUser,
      deleteUser,
      copyCredentials,
      visiblePasswords,
      togglePasswordVisibility,
      fullDateFormat,
      fullDateTimeFormat,
    ]
  );

  const closeUserForm = () => {
    setSelectedUser(null);
    setUserModalOpen(false);
  };

  const data = useMemo(() => {
    return users.sort((a, b) => a.id - b.id);
  }, [users]);

  const renderHeaderCell = (header) => {
    return (
      <Text size="sm" name={header.id}>
        {header.column.columnDef.header}
      </Text>
    );
  };

  const table = useTable({
    columns,
    data,
    allRowIds: data.map((user) => user.id),
    enablePagination: false,
    enableRowSelection: false,
    enableRowVirtualization: false,
    renderTopToolbar: false,
    manualSorting: false,
    manualFiltering: false,
    manualPagination: false,
    headerCellRenderFns: {
      actions: renderHeaderCell,
      username: renderHeaderCell,
      name: renderHeaderCell,
      email: renderHeaderCell,
      user_level: renderHeaderCell,
      last_login: renderHeaderCell,
      date_joined: renderHeaderCell,
      custom_properties: renderHeaderCell,
    },
  });

  return (
    <>
      <Box
        style={{
          display: 'flex',
          justifyContent: 'center',
          padding: '0px',
          minHeight: '100vh',
        }}
      >
        <Stack gap="md" style={{ maxWidth: '1600px', width: '100%' }}>
          <Flex style={{ alignItems: 'center', paddingBottom: 10 }} gap={15}>
            <Text
              style={{
                fontFamily: 'Inter, sans-serif',
                fontWeight: 500,
                fontSize: '20px',
                lineHeight: 1,
                letterSpacing: '-0.3px',
                color: 'gray.6',
                marginBottom: 0,
              }}
            >
              Users
            </Text>
          </Flex>

          <Paper
            style={{
              backgroundColor: '#27272A',
              border: '1px solid #3f3f46',
              borderRadius: 'var(--mantine-radius-md)',
            }}
          >
            {/* Top toolbar */}
            <Box
              style={{
                display: 'flex',
                justifyContent: 'flex-end',
                padding: '16px',
                borderBottom: '1px solid #3f3f46',
              }}
            >
              <Group gap="xs">
                <Button
                  leftSection={<Users size={18} />}
                  variant="light"
                  size="xs"
                  onClick={() => setBulkGenerateOpen(true)}
                  p={5}
                  color={theme.tailwind.blue[5]}
                  style={{
                    borderWidth: '1px',
                    borderColor: theme.tailwind.blue[5],
                    color: 'white',
                  }}
                  disabled={authUser.user_level < USER_LEVELS.RESELLER}
                >
                  Bulk Generate
                </Button>
                <Button
                  leftSection={<SquarePlus size={18} />}
                  variant="light"
                  size="xs"
                  onClick={() => editUser()}
                  p={5}
                  color={theme.tailwind.green[5]}
                  style={{
                    borderWidth: '1px',
                    borderColor: theme.tailwind.green[5],
                    color: 'white',
                  }}
                  disabled={authUser.user_level < USER_LEVELS.RESELLER}
                >
                  Add User
                </Button>
              </Group>
            </Box>

            {/* Table container */}
            <Box
              style={{
                position: 'relative',
                overflow: 'auto',
                borderRadius:
                  '0 0 var(--mantine-radius-md) var(--mantine-radius-md)',
              }}
            >
              <div style={{ minWidth: '900px' }}>
                <LoadingOverlay visible={isLoading} />
                <CustomTable table={table} />
              </div>
            </Box>
          </Paper>
        </Stack>
      </Box>

      <UserForm
        user={selectedUser}
        isOpen={userModalOpen}
        onClose={closeUserForm}
      />

      <ConfirmationDialog
        opened={confirmDeleteOpen}
        onClose={() => setConfirmDeleteOpen(false)}
        onConfirm={() => executeDeleteUser(deleteTarget)}
        loading={deleting}
        title="Confirm User Deletion"
        message={
          userToDelete ? (
            <div style={{ whiteSpace: 'pre-line' }}>
              {`Are you sure you want to delete the following user?

Username: ${userToDelete.username}
Email: ${userToDelete.email}
User Level: ${USER_LEVEL_LABELS[userToDelete.user_level]}

This action cannot be undone.`}
            </div>
          ) : (
            'Are you sure you want to delete this user? This action cannot be undone.'
          )
        }
        confirmLabel="Delete"
        cancelLabel="Cancel"
        actionKey="delete-user"
        onSuppressChange={suppressWarning}
        size="md"
      />

      <UserBulkGenerate
        isOpen={bulkGenerateOpen}
        onClose={() => setBulkGenerateOpen(false)}
      />
    </>
  );
};

export default UsersTable;
