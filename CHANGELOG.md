# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).


## [0.2.0] - 2026-02-20

### Added
- Backend: Added channel `stream_source` filtering.
- Added `/ids` endpoint and a `remap` action to `ChannelViewSet` to swap streams by `tvg_id`.
- Added `clear_vod_for_account` and `clear_vod_for_category` Celery tasks.

### Changed
- Wired VOD enable/disable flows in `M3UAccountViewSet`, including an explicit `clear-vod` action and category disable cleanup.
- Refined output endpoints to only return channels with active or custom streams.
- Updated profile creation to ignore inactive M3U accounts when creating from sources.

## [0.1.1] - 2026-02-15

### Fixed
- Fixed a `NameError` in XC API `get_live_categories` where `request` was not defined.
- Fixed a `FieldError` in XC API `get_vod_categories` and `get_series_categories` caused by non-existent `image` field in `VODCategory` model.

## [0.1.0] - 2026-02-14

### Added
- Included `uuid` in Xtream Codes (XC) API responses for Live, VOD, and Series/Episodes. This allows external clients to reconstruct the exact same URLs used in the Dispatcharr dashboard.
- Added `series_uuid` to single series info and `stream_uuid` to movie info in the XC API for better data mapping.

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
