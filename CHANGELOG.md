# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).


## [0.0.2] - 2026-02-14

### Changed
- Updated menu labels to better reflect functionality:
  - "M3U & EPG Manager" → "M3U/XC/EPG Manager"
  - "M3U Accounts" → "M3U and XC Accounts"
  - "Add M3U" button → "Add Account"

### Removed
- Completely removed credits system from user management
  - Removed credits display from sidebar
  - Removed credits fields from user forms
  - Removed credits column from users table
  - Removed credits validation from bulk user generation

## [0.0.1] - 2026-02-14

### Initial Fork Release

This is the initial release of the Dispatcharr fork, featuring a complete rebuild with advanced stream hosting and management capabilities.

#### Key Features

- **All-New Profile Management**: Intuitive drag-and-drop interface for organizing and managing profiles with ease
- **Advanced User Management**: Per-user connection limits (Redis-backed) and account expiration
- **Full Xtream Codes API**: High-performance implementation for wide client compatibility
- **Proxy Security**: Authenticated playback tracking across both M3U and XC protocols
- **Group Management**: Enhanced group organization with hide/show functionality
- **Stream Management**: Comprehensive stream organization and filtering capabilities
- **EPG Integration**: Advanced EPG matching and management
- **VOD Support**: Complete Video on Demand system with movies and TV series
- **DVR System**: Recording and playback capabilities
- **Plugin System**: Extensible framework for custom functionality
- **Logo Management**: Comprehensive logo management with deduplication
- **Network Access Control**: CIDR-based network restrictions
- **Hardware Acceleration**: Support for NVIDIA, Intel QSV, and VAAPI
- **Multiple Streaming Backends**: VLC, FFmpeg, and Streamlink support

#### Technical Highlights

- Built on Django 5.2+ with React frontend
- Redis-backed connection management
- PostgreSQL database with optimized queries
- WebSocket support for real-time updates
- Docker-based deployment with multi-architecture support (ARM/AMD64)
- Comprehensive API with OpenAPI 3.0 documentation

#### License Compliance

This fork is released under CC BY-NC-SA 4.0 license, ensuring non-commercial use only. All features have been reviewed and modified to comply with license requirements.
