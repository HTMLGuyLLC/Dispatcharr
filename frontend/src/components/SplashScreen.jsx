import React from 'react';
import { Box, Image, Text, Loader, Center, Stack } from '@mantine/core';
import logo from '../images/logo.png';

const SplashScreen = () => {
    return (
        <Center style={{ height: '100vh', width: '100vw', backgroundColor: '#18181b', position: 'fixed', top: 0, left: 0, zIndex: 9999 }}>
            <Stack align="center" gap="xl">
                <Box
                    style={{
                        animation: 'pulse 2s infinite ease-in-out',
                        filter: 'drop-shadow(0 0 15px rgba(255, 255, 255, 0.1))'
                    }}
                >
                    <Image
                        src={logo}
                        w={120}
                        h={120}
                        fit="contain"
                        fallbackSrc="https://via.placeholder.com/120?text=Dispatcharr"
                    />
                </Box>
                <Stack align="center" gap="xs">
                    <Text size="xl" fw={700} c="white" style={{ letterSpacing: '1px' }}>
                        DISPATCHARR
                    </Text>
                    <Loader color="blue" size="sm" type="bars" />
                </Stack>
            </Stack>
            <style>
                {`
          @keyframes pulse {
            0% { transform: scale(0.95); opacity: 0.8; }
            50% { transform: scale(1); opacity: 1; }
            100% { transform: scale(0.95); opacity: 0.8; }
          }
        `}
            </style>
        </Center>
    );
};

export default SplashScreen;
