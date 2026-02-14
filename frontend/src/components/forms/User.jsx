// Modal.js
import React, { useState, useEffect } from 'react';
import API from '../../api';
import {
  TextInput,
  Button,
  Modal,
  Flex,
  Select,
  PasswordInput,
  Group,
  Stack,
  MultiSelect,
  ActionIcon,
  Switch,
  Box,
  Tooltip,
  NumberInput,
  Text,
} from '@mantine/core';
import { DateTimePicker } from '@mantine/dates';
import dayjs from 'dayjs';
import { RotateCcwKey, X, Calendar, Copy } from 'lucide-react';
import { useForm } from '@mantine/form';
import useChannelsStore from '../../store/channels';
import { USER_LEVELS, USER_LEVEL_LABELS } from '../../constants';
import useAuthStore from '../../store/auth';
import useSettingsStore from '../../store/settings';
import { notifications } from '@mantine/notifications';

const User = ({ user = null, isOpen, onClose }) => {
  const profiles = useChannelsStore((s) => s.profiles);
  const currentUser = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
  const [showPermissions, setShowPermissions] = useState(false);
  const [enableXC, setEnableXC] = useState(false);
  const [syncingXC, setSyncingXC] = useState(false);
  const [sourceServerName, setSourceServerName] = useState('');
  const [selectedProfiles, setSelectedProfiles] = useState(new Set());

  const form = useForm({
    mode: 'controlled',
    initialValues: {
      username: '',
      first_name: '',
      last_name: '',
      email: '',
      user_level: '0',
      password: '',
      xc_password: '',
      channel_profiles: [],
      hide_adult_content: false,
      xc_passthrough_enabled: false,
      connection_limit: 1,
      expires_at: null,
      credits: 0,
      reseller_credit_mode: 'user',
      reseller_refunds_enabled: false,
    },

    validate: (values) => ({
      username: !values.username
        ? 'Username is required'
        : values.user_level == USER_LEVELS.STREAMER &&
          !values.username.match(/^[a-z0-9]+$/i)
          ? 'Streamer username must be alphanumeric'
          : null,
      password:
        !user && !values.password && values.user_level != USER_LEVELS.STREAMER
          ? 'Password is requried'
          : null,
      xc_password:
        values.xc_password && !values.xc_password.match(/^[a-z0-9]+$/i)
          ? 'XC password must be alphanumeric'
          : null,
    }),
  });

  const onChannelProfilesChange = (values) => {
    let newValues = new Set(values);
    if (selectedProfiles.has('0')) {
      newValues.delete('0');
    } else if (newValues.has('0')) {
      newValues = new Set(['0']);
    }

    setSelectedProfiles(newValues);

    form.setFieldValue('channel_profiles', [...newValues]);
  };

  const onSubmit = async () => {
    const values = form.getValues();

    const customProps = user?.custom_properties || {};

    // Always save xc_password, even if it's empty (to allow clearing)
    customProps.xc_password = values.xc_password || '';
    delete values.xc_password;

    // Save hide_adult_content in custom_properties
    customProps.hide_adult_content = values.hide_adult_content || false;
    delete values.hide_adult_content;

    // Save xc_passthrough_enabled in custom_properties
    customProps.xc_passthrough_enabled = values.xc_passthrough_enabled || false;
    delete values.xc_passthrough_enabled;

    values.custom_properties = customProps;

    // Convert numeric fields from string if they came from Select/NumberInput
    values.connection_limit = parseInt(values.connection_limit) || 1;
    values.credits = parseInt(values.credits) || 0;
    values.user_level = parseInt(values.user_level);

    if (values.expires_at) {
      values.expires_at = dayjs(values.expires_at).toISOString();
    } else {
      values.expires_at = null;
    }

    // If 'All' is included, clear this and we assume access to all channels
    if (values.channel_profiles.includes('0')) {
      values.channel_profiles = [];
    }

    if (!user && values.user_level == USER_LEVELS.STREAMER) {
      // Generate random password - they can't log in, but user can't be created without a password
      values.password = Math.random().toString(36).slice(2);
    }

    if (!user) {
      await API.createUser(values);
    } else {
      if (!values.password) {
        delete values.password;
      }

      const response = await API.updateUser(user.id, values);

      if (user.id == currentUser.id) {
        setUser(response);
      }
    }

    form.reset();
    onClose();
  };

  useEffect(() => {
    if (user?.id) {
      const customProps = user.custom_properties || {};

      form.setValues({
        username: user.username,
        first_name: user.first_name || '',
        last_name: user.last_name || '',
        email: user.email,
        user_level: `${user.user_level}`,
        channel_profiles:
          user.channel_profiles.length > 0
            ? user.channel_profiles.map((id) => `${id}`)
            : ['0'],
        xc_password: customProps.xc_password || '',
        hide_adult_content: customProps.hide_adult_content || false,
        xc_passthrough_enabled: customProps.xc_passthrough_enabled || false,
        connection_limit: user.connection_limit || 1,
        expires_at: user.expires_at ? new Date(user.expires_at) : null,
        credits: user.credits || 0,
      });

      const initialProfileIds = user.channel_profiles.length > 0
        ? user.channel_profiles.map((id) => `${id}`)
        : ['0'];
      setSelectedProfiles(new Set(initialProfileIds));

      if (customProps.xc_password) {
        setEnableXC(true);
      }
      if (customProps.xc_passthrough_enabled) {
        // If passthrough is enabled, we need to re-validate to get the server name
        const xc_password = customProps.xc_password;
        const username = user.username;
        const profile_ids = user.channel_profiles.length > 0 ? user.channel_profiles.map(id => `${id}`) : ['0'];

        if (xc_password && username) {
          setSyncingXC(true);
          API.validateXCCredentials({
            xc_username: username,
            xc_password: xc_password,
            profile_ids: profile_ids,
          }).then(res => {
            if (res.success) {
              setSourceServerName(res.server_name);
            }
          }).catch(() => {
            // If validation fails on load, disable passthrough
            form.setFieldValue('xc_passthrough_enabled', false);
            setSourceServerName('');
          }).finally(() => {
            setSyncingXC(false);
          });
        } else {
          form.setFieldValue('xc_passthrough_enabled', false);
        }
      }
    } else {
      setSourceServerName('');
      form.reset();
    }
    setShowPermissions(currentUser.user_level == USER_LEVELS.ADMIN && currentUser.id !== user?.id);
  }, [user, currentUser]);

  const generateXCPassword = () => {
    form.setValues({
      xc_password: Math.random().toString(36).slice(2),
    });
  };

  const copyCredentials = () => {
    const values = form.getValues();
    const hostname = window.location.hostname;
    const port = window.location.port;
    const protocol = window.location.protocol; // 'http:' or 'https:'

    const env_mode = useSettingsStore.getState().environment.env_mode;

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
    let profileNames = 'All Profiles';
    if (values.channel_profiles && values.channel_profiles.length > 0 && !values.channel_profiles.includes('0')) {
      profileNames = values.channel_profiles
        .map(id => profiles[id]?.name)
        .filter(Boolean)
        .join(', ');
    }

    // Format expiration date
    let expirationText = 'Never';
    if (values.expires_at) {
      expirationText = dayjs(values.expires_at).format('MMMM D, YYYY [at] h:mm A');
    }

    const credentialsText = `Here's your Xtream login details!

Hostname: ${fullHostname}
Username: ${values.username}
Password: ${values.xc_password || 'Not set'}
Connections: ${values.connection_limit || 1}
Expiration: ${expirationText}
Profile(s): ${profileNames}`;

    navigator.clipboard.writeText(credentialsText).then(() => {
      notifications.show({
        title: 'Credentials Copied!',
        message: 'User credentials have been copied to clipboard',
        color: 'green',
      });
    }).catch(() => {
      notifications.show({
        title: 'Copy Failed',
        message: 'Failed to copy credentials to clipboard',
        color: 'red',
      });
    });
  };

  if (!isOpen) {
    return <></>;
  }

  return (
    <Modal opened={isOpen} onClose={onClose} title="User" size="xl">
      <form onSubmit={form.onSubmit(onSubmit)}>
        <Group justify="space-between" align="top">
          <Stack gap="xs" style={{ flex: 1 }}>
            <TextInput
              id="username"
              name="username"
              label="Username"
              {...form.getInputProps('username')}
              key={form.key('username')}
            />

            <TextInput
              id="first_name"
              name="first_name"
              label="First Name"
              {...form.getInputProps('first_name')}
              key={form.key('first_name')}
            />

            <PasswordInput
              label="Password"
              description="Used for UI authentication"
              {...form.getInputProps('password')}
              key={form.key('password')}
              disabled={form.getValues().user_level == USER_LEVELS.STREAMER}
            />

            {showPermissions && (
              <Select
                label="User Level"
                data={Object.entries(USER_LEVELS).map(([, value]) => {
                  return {
                    label: USER_LEVEL_LABELS[value],
                    value: `${value}`,
                  };
                })}
                {...form.getInputProps('user_level')}
                key={form.key('user_level')}
              />
            )}



            {showPermissions && (
              <NumberInput
                label={
                  <Group gap="xs">
                    <span>Connection Limit</span>
                    {form.values.xc_passthrough_enabled && (
                      <Box component="span" style={{ fontSize: '10px', color: 'var(--mantine-color-blue-filled)', fontWeight: 'bold' }}>
                        (LOCKED BY SOURCE {sourceServerName})
                      </Box>
                    )}
                  </Group>
                }
                description="Maximum concurrent streams"
                min={1}
                {...form.getInputProps('connection_limit')}
                key={form.key('connection_limit')}
                disabled={form.values.xc_passthrough_enabled}
              />
            )}

            {showPermissions && (
              <DateTimePicker
                label={
                  <Group gap="xs">
                    <span>Account Expiration</span>
                    {form.values.xc_passthrough_enabled && (
                      <Box component="span" style={{ fontSize: '10px', color: 'var(--mantine-color-blue-filled)', fontWeight: 'bold' }}>
                        (LOCKED BY SOURCE {sourceServerName})
                      </Box>
                    )}
                  </Group>
                }
                placeholder="Pick date and time"
                leftSection={
                  <Calendar size={16} style={{ color: 'var(--mantine-color-dimmed)' }} />
                }
                {...form.getInputProps('expires_at')}
                key={form.key('expires_at')}
                clearable
                disabled={form.values.xc_passthrough_enabled}
              />
            )}
          </Stack>

          <Stack gap="xs" style={{ flex: 1 }}>
            <TextInput
              id="email"
              name="email"
              label="E-Mail"
              {...form.getInputProps('email')}
              key={form.key('email')}
            />

            <TextInput
              id="last_name"
              name="last_name"
              label="Last Name"
              {...form.getInputProps('last_name')}
              key={form.key('last_name')}
            />

            <Group align="flex-end">
              <TextInput
                label="XC Password"
                description="Clear to disable XC API"
                {...form.getInputProps('xc_password')}
                key={form.key('xc_password')}
                style={{ flex: 1 }}
                rightSectionWidth={30}
                rightSection={
                  <ActionIcon
                    variant="transparent"
                    size="sm"
                    color="white"
                    onClick={generateXCPassword}
                  >
                    <RotateCcwKey />
                  </ActionIcon>
                }
              />
            </Group>

            {showPermissions && (
              <MultiSelect
                label="Channel Profiles"
                {...form.getInputProps('channel_profiles')}
                key={form.key('channel_profiles')}
                onChange={onChannelProfilesChange}
                data={[
                  { label: 'All Profiles', value: '0' },
                  ...Object.values(profiles || {})
                    .filter((profile) => {
                      // Filter out the 'All Profiles' profile (ID 0) to avoid duplicates
                      const profileIdStr = String(profile.id);
                      return profileIdStr !== '0';
                    })
                    .map((profile) => ({
                      label: String(profile.name || 'Unnamed'),
                      value: String(profile.id),
                    }))
                ]}
                searchable
                clearable
              />
            )}

            {showPermissions && (
              <Box mt="xs">
                <Tooltip
                  label="Use this user's credentials to authenticate with the source XC server instead of the configured account credentials"
                  position="top"
                  withArrow
                >
                  <Switch
                    label="Passthrough credentials to source XC server"
                    checked={form.values.xc_passthrough_enabled}
                    onChange={async (event) => {
                      const checked = event.currentTarget.checked;
                      form.setFieldValue('xc_passthrough_enabled', checked);

                      if (checked) {
                        const values = form.getValues();
                        const xc_password = values.xc_password;
                        const username = values.username;
                        const profile_ids = values.channel_profiles;

                        if (!xc_password || !username) {
                          notifications.show({
                            title: 'Error',
                            message: 'Username and XC password are required to enable passthrough',
                            color: 'red',
                          });
                          form.setFieldValue('xc_passthrough_enabled', false);
                          return;
                        }

                        setSyncingXC(true);
                        try {
                          const res = await API.validateXCCredentials({
                            xc_username: username,
                            xc_password: xc_password,
                            profile_ids: profile_ids,
                          });

                          if (res.success) {
                            form.setFieldValue('connection_limit', res.max_connections);
                            form.setFieldValue('expires_at', res.exp_date ? new Date(res.exp_date) : null);
                            setSourceServerName(res.server_name);
                            notifications.show({
                              title: 'Success',
                              message: `Credentials validated with ${res.server_name}. Connection limit and expiration updated.`,
                              color: 'green',
                            });
                          }
                        } catch (err) {
                          notifications.show({
                            title: 'Validation Failed',
                            message: err.body?.error || 'Failed to authenticate with source XC server',
                            color: 'red',
                          });
                          form.setFieldValue('xc_passthrough_enabled', false);
                        } finally {
                          setSyncingXC(false);
                        }
                      } else {
                        setSourceServerName('');
                      }
                    }}
                    disabled={syncingXC}
                  />
                </Tooltip>
                <Text size="xs" c="dimmed" mt={5} style={{ fontStyle: 'italic', lineHeight: 1.2 }}>
                  Note: Passthrough depends on selecting a profile that only contains streams where these credentials are valid for both this service and the source (Source &gt; Group in Profile &gt; Profile on user).
                </Text>
              </Box>
            )}

            {showPermissions && (
              <Box mt="xs">
                <Tooltip
                  label="Hide channels marked as mature content (admin users not affected)"
                  position="top"
                  withArrow
                >
                  <Switch
                    label="Hide Mature Content"
                    {...form.getInputProps('hide_adult_content', {
                      type: 'checkbox',
                    })}
                    key={form.key('hide_adult_content')}
                  />
                </Tooltip>
              </Box>
            )}



            {/* Admin-only controls for Reseller Configuration */}
            {currentUser.user_level === USER_LEVELS.ADMIN &&
              form.getValues().user_level == USER_LEVELS.RESELLER && (
                <>
                  <NumberInput
                    label="Credits"
                    description="Available for creating sub-users"
                    {...form.getInputProps('credits')}
                    key={form.key('credits')}
                  />
                  <Select
                    label="Credit Mode"
                    data={[
                      { label: 'Per User', value: 'user' },
                      { label: 'Per Connection', value: 'connection' },
                    ]}
                    {...form.getInputProps('reseller_credit_mode')}
                    key={form.key('reseller_credit_mode')}
                  />
                  <Switch
                    label="Enable Refunds"
                    description="Refund credits on user delete/downgrade"
                    {...form.getInputProps('reseller_refunds_enabled', {
                      type: 'checkbox',
                    })}
                    key={form.key('reseller_refunds_enabled')}
                    mt="xs"
                  />
                </>
              )}
          </Stack>
        </Group>

        <Flex mih={50} gap="xs" justify="space-between" align="flex-end">
          {user && (
            <Button
              variant="light"
              leftSection={<Copy size={16} />}
              onClick={copyCredentials}
              size="compact-sm"
            >
              Copy XC Credentials
            </Button>
          )}
          <Button
            type="submit"
            variant="contained"
            disabled={form.submitting}
            size="small"
            ml="auto"
          >
            Save
          </Button>
        </Flex>
      </form>
    </Modal>
  );
};

export default User;
