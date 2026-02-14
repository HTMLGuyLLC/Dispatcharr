// frontend/src/components/forms/SuperuserForm.js
import React, { useState, useEffect } from 'react';
import {
  TextInput,
  Center,
  Button,
  Paper,
  Title,
  Stack,
  Text,
  Image,
  Divider,
} from '@mantine/core';
import API from '../../api';
import useAuthStore from '../../store/auth';
import useSettingsStore from '../../store/settings';
import logo from '../../assets/logo.png';

function SuperuserForm() {
  const [formData, setFormData] = useState({
    username: '',
    password: '',
    email: '',
    xc_password: '',
  });
  const [error, setError] = useState('');
  const setSuperuserExists = useAuthStore((s) => s.setSuperuserExists);
  const fetchVersion = useSettingsStore((s) => s.fetchVersion);
  const storedVersion = useSettingsStore((s) => s.version);

  useEffect(() => {
    // Fetch version info using the settings store (will skip if already loaded)
    fetchVersion();
  }, [fetchVersion]);

  const handleChange = (e) => {
    setFormData((prev) => ({
      ...prev,
      [e.target.name]: e.target.value,
    }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      console.log(formData);
      const response = await API.createSuperUser({
        username: formData.username,
        password: formData.password,
        email: formData.email,
        xc_password: formData.xc_password,
      });
      if (response.superuser_exists) {
        setSuperuserExists(true);
      }
    } catch (err) {
      console.log(err);
      setError('Failed to create superuser.');
    }
  };

  return (
    <Center
      style={{
        height: '100vh',
      }}
    >
      <Paper
        elevation={3}
        style={{
          padding: 30,
          width: '100%',
          maxWidth: 500,
          position: 'relative',
        }}
      >
        <Stack align="center" spacing="lg">
          <Image
            src={logo}
            alt="Dispatcharr Logo"
            width={120}
            height={120}
            fit="contain"
          />
          <Title order={2} align="center">
            Dispatcharr
          </Title>
          <Text size="sm" color="dimmed" align="center">
            Welcome! Create your Super User Account to get started.
          </Text>
          <Divider style={{ width: '100%' }} />
        </Stack>
        <form onSubmit={handleSubmit}>
          <Stack>
            <TextInput
              label="Username"
              name="username"
              value={formData.username}
              onChange={handleChange}
              required
            />
            <TextInput
              label="Password"
              type="password"
              name="password"
              value={formData.password}
              onChange={handleChange}
              required
            />

            <TextInput
              label="Email (optional)"
              type="email"
              name="email"
              value={formData.email}
              onChange={handleChange}
            />

            <TextInput
              label="XC Password (optional)"
              description="Used for Xtream Codes API access"
              name="xc_password"
              value={formData.xc_password}
              onChange={handleChange}
              rightSection={
                <Button
                  variant="subtle"
                  size="compact-xs"
                  onClick={() => setFormData(prev => ({ ...prev, xc_password: Math.random().toString(36).slice(2) }))}
                >
                  Generate
                </Button>
              }
              rightSectionWidth={70}
            />

            <Button type="submit" fullWidth>
              Create Account
            </Button>
          </Stack>
        </form>

        {storedVersion.version && (
          <Text
            size="xs"
            color="dimmed"
            style={{
              position: 'absolute',
              bottom: 6,
              right: 30,
            }}
          >
            v{storedVersion.version}
          </Text>
        )}
      </Paper>
    </Center>
  );
}

export default SuperuserForm;
