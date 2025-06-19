# AI Context: ONVIF Camera Homey App

## Project Overview

This is a **Homey smart home app** for integrating **ONVIF-compatible IP cameras** with the Homey platform. The app enables home security automation by providing motion detection, image capture, and various camera event triggers for flow automation.

## Key Information for AI Assistants

### Project Type

- **Platform**: Homey (Athom smart home platform)
- **Type**: Smart home device integration app
- **SDK Version**: Homey SDK 3
- **License**: GPL-3.0
- **Language**: JavaScript (Node.js)
- **Minimum Node Version**: 14.0.0

### Core Functionality

- **ONVIF Camera Integration**: Discovers and connects to ONVIF-compatible IP cameras
- **Motion Detection**: Real-time motion alerts with flow triggers
- **Image Capture**: Live snapshots and motion-triggered images
- **Event Management**: Various camera events (face detection, line crossing, sound, etc.)
- **Push Notifications**: HTTP server for receiving camera events
- **Multi-language Support**: English, German, Dutch, Italian, French

### Architecture

#### Main Components

1. **App Controller** (`app.js`): Main application logic, discovery, and HTTP server
2. **Camera Driver** (`drivers/camera/driver.js`): Device pairing and flow card registration
3. **Camera Device** (`drivers/camera/device.js`): Individual camera instance management
4. **API Handler** (`api.js`): REST API endpoints for settings and diagnostics

#### Key Dependencies

- `onvif`: ONVIF protocol implementation for camera communication
- `digest-fetch`: HTTP digest authentication for camera access
- `node-fetch`: HTTP client for API requests
- `nodemailer`: Email notifications (if configured)
- `xml2js`: XML parsing for ONVIF responses

### Device Capabilities

The app supports cameras with various capabilities:

- Motion detection (`alarm_motion`)
- Face detection (`alarm_face`)
- Person detection (`alarm_person`)
- Vehicle detection (`alarm_vehicle`)
- Dog/cat detection (`alarm_dog_cat`)
- Line crossing detection (`alarm_line_crossed`)
- Sound detection (`alarm_sound`)
- Storage alerts (`alarm_storage`)
- Tamper detection (`alarm_tamper`)
- Dark image detection (`alarm_dark_image`)

### Flow Integration

The app provides extensive Homey flow integration:

- **Triggers**: Motion detected, face detected, line crossed, etc.
- **Conditions**: Check motion state, camera enabled status
- **Actions**: Enable/disable motion detection, take snapshots

### Configuration Structure

#### App Settings

- Port for HTTP push server (default: 9998)
- Log level for debugging
- Diagnostic logging

#### Device Settings

- IP address and port
- Username/password credentials
- Motion detection preferences
- Event notification types
- Snapshot URLs and tokens
- Pull vs push event modes

### File Structure Context

#### Root Files

- `app.js`: Main application entry point
- `app.json`: Homey app manifest (auto-generated from .homeycompose)
- `api.js`: REST API endpoints
- `package.json`: Node.js dependencies and scripts

#### Drivers

- `drivers/camera/`: Camera device driver implementation
- `drivers/camera/pair/`: Pairing flow HTML templates
- `drivers/camera/repair/`: Device repair flow templates

#### Assets

- `assets/`: App icons and images
- `assets/images/`: App store images (large/small)
- Various SVG icons for different capabilities

#### Localization

- `locales/`: Translation files for multiple languages

#### Settings

- `settings/`: Web-based settings interface with HTML/CSS/JS

### Development Guidelines

#### Code Style

- ESLint with Athom configuration
- JSDoc comments for API documentation
- Strict mode JavaScript
- Error handling with try/catch blocks

#### Common Patterns

- Homey Device/Driver/App inheritance
- Async/await for promises
- Capability-based device features
- Flow card registration and handling

#### Key Methods to Understand

- `discoverCameras()`: ONVIF device discovery
- `connectCamera()`: Establish camera connection
- `getSnapshot()`: Capture camera images
- `enableEvents()`: Subscribe to camera events
- Flow trigger methods for various alarms

### Debugging & Testing

- Debug mode available via environment variable
- Diagnostic logging to settings
- Port configuration for development
- ESLint for code quality

### Common Development Tasks

1. **Adding new camera capabilities**: Extend device capabilities and flow cards
2. **ONVIF protocol updates**: Modify camera communication logic
3. **UI improvements**: Update pairing/settings interfaces
4. **Localization**: Add new language support
5. **Event handling**: Extend motion/alarm detection types

### Security Considerations

- Digest authentication for camera access
- Credential storage in device settings
- HTTP server for push notifications
- Input validation for camera configurations

### Performance Notes

- Event polling vs push notifications
- Image caching for snapshots
- Connection pooling for multiple cameras
- Memory management for large images

This project integrates deeply with both ONVIF camera protocols and the Homey platform ecosystem. Understanding both domains is crucial for effective modifications.
