# Environment Variables

This document describes the environment variables used by Archifiltre for configuration, logging, and analytics.

## Overview

Archifiltre uses environment variables to configure external services while maintaining a **privacy-first approach**. All external integrations are **disabled by default** and require explicit configuration and user consent.

## Privacy & Security

⚠️ **Important Security Notes:**
- Never commit API keys or DSNs to version control
- Use `.env` files or secure environment management systems
- External services only activate when both environment variables are set AND user consent is given
- All data is sanitized before being sent to external services

## Logging System Variables

### Sentry (Error Tracking)

Sentry integration for error tracking and monitoring. Only errors and warnings are sent.

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `SENTRY_DSN` | Sentry Data Source Name for error reporting | `undefined` | No |
| `SENTRY_ENVIRONMENT` | Environment name (production, staging, development) | `production` | No |
| `SENTRY_SAMPLE_RATE` | Error sampling rate (0.0 to 1.0) | `1.0` | No |

#### Example
```bash
# Enable Sentry error tracking
SENTRY_DSN=https://examplePublicKey@o0.ingest.sentry.io/0
SENTRY_ENVIRONMENT=production
SENTRY_SAMPLE_RATE=0.1
```

#### Finding Your Sentry DSN
1. Go to [Sentry.io](https://sentry.io) and create/select your project
2. Navigate to **Settings > Projects > [Your Project] > Client Keys (DSN)**
3. Copy the DSN value

## Analytics System Variables  

### PostHog (Product Analytics)

PostHog integration for user behavior analytics and feature flags. Only activated with user consent.

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `POSTHOG_API_KEY` | PostHog project API key for analytics | `undefined` | No |
| `POSTHOG_HOST` | PostHog instance URL | `https://app.posthog.com` | No |

#### Example
```bash
# Enable PostHog analytics (requires user consent)
POSTHOG_API_KEY=phc_your_project_api_key_here
POSTHOG_HOST=https://us.i.posthog.com
```

#### Finding Your PostHog API Key
1. Go to [PostHog](https://posthog.com) and select your project
2. Navigate to **Project Settings**
3. Copy the **Project API Key** (not Personal API Key)

## Application Variables

### General Configuration

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `NODE_ENV` | Application environment | `development` | No |
| `CI` | Indicates if running in CI/CD | `false` | No |
| `NO_COLOR` | Disable colored output | `false` | No |

## Usage Examples

### Development Environment

```bash
# .env.development
NODE_ENV=development
# External services disabled for privacy and faster development
```

### Staging Environment

```bash
# .env.staging  
NODE_ENV=production
SENTRY_DSN=https://staging-key@o0.ingest.sentry.io/0
SENTRY_ENVIRONMENT=staging
POSTHOG_API_KEY=phc_staging_key_here
```

### Production Environment

```bash
# .env.production
NODE_ENV=production
SENTRY_DSN=https://prod-key@o0.ingest.sentry.io/0
SENTRY_ENVIRONMENT=production
SENTRY_SAMPLE_RATE=0.1
POSTHOG_API_KEY=phc_prod_key_here
```

## Privacy-First Architecture

### Default Behavior (No Environment Variables)
- ✅ **Console logging** - Always active
- ❌ **Sentry error tracking** - Disabled  
- ❌ **PostHog analytics** - Disabled
- 🔒 **No external data transmission**

### With Environment Variables Set
- ✅ **Console logging** - Always active
- ⚠️ **Sentry error tracking** - Available but requires user consent
- ⚠️ **PostHog analytics** - Available but requires user consent
- 🔒 **User controls all external data sharing**

## Configuration in Code

### Logging Configuration
```typescript
import { initializeLogging } from '@infra/logging';

await initializeLogging({
  enableTelemetry: false, // User must explicitly consent
  sentryDsn: process.env.SENTRY_DSN, // Only used if user consents
  environment: process.env.NODE_ENV,
});
```

### Analytics Configuration
```typescript
import { initializeAnalytics } from '@infra/analytics';

await initializeAnalytics({
  enableAnalytics: false, // User must explicitly consent
  userConsent: 'none', // Default: no tracking
  postHogApiKey: process.env.POSTHOG_API_KEY, // Only used if user consents
});
```

## User Consent Flow

Even when environment variables are set, external services require explicit user consent:

```typescript
// 1. Check if user wants error tracking
const userWantsErrorTracking = await askUserForErrorTrackingConsent();

if (userWantsErrorTracking) {
  await initializeLogging({
    enableTelemetry: true, // User consented
    sentryDsn: process.env.SENTRY_DSN,
  });
}

// 2. Check if user wants analytics
const userWantsAnalytics = await askUserForAnalyticsConsent();

if (userWantsAnalytics) {
  await initializeAnalytics({
    enableAnalytics: true, // User consented  
    userConsent: 'anonymous', // or 'identified'
    postHogApiKey: process.env.POSTHOG_API_KEY,
  });
}
```

## Environment Variable Validation

### Checking Configuration
```bash
# Check current configuration
./archifiltre health --verbose

# Outputs:
# ✅ Console logging: enabled
# ⚠️ Sentry: configured but disabled (no user consent)
# ⚠️ PostHog: configured but disabled (no user consent)
```

### Runtime Validation
```typescript
import { logger, analytics } from '@api/index';

// Check if external services are available
console.log('Sentry available:', await isSentryAvailable());
console.log('PostHog available:', await isPostHogAvailable());

// Check if services are enabled (requires consent)
console.log('Logging enabled:', logger.isEnabled());
console.log('Analytics enabled:', analytics.isEnabled());
```

## Troubleshooting

### Common Issues

**Environment variables not loading:**
```bash
# Check if .env file is in the correct location
ls -la .env*

# Verify environment variables are set
echo $SENTRY_DSN
echo $POSTHOG_API_KEY
```

**Services not initializing:**
```bash
# Check if external packages are installed
bun list | grep sentry
bun list | grep posthog

# Install if needed (optional dependencies)
bun add @sentry/node posthog-node
```

**Logs not appearing in external services:**
- ✅ Verify environment variables are set correctly
- ✅ Check user has granted consent for external services
- ✅ Confirm API keys/DSNs are valid and active
- ✅ Check network connectivity and firewall settings

### Debug Mode
```bash
# Enable verbose logging to see configuration
NODE_ENV=development ./archifiltre health --verbose --log-format json
```

## Best Practices

### Security
- Use different API keys for development, staging, and production
- Rotate API keys regularly
- Monitor usage and costs in external service dashboards
- Use least-privilege API keys when possible

### Privacy
- Always ask for user consent before enabling external services
- Provide clear privacy policies explaining data collection
- Offer granular consent options (error tracking vs analytics)
- Allow users to revoke consent at any time

### Development
- Keep external services disabled during development by default
- Use staging environments with separate API keys
- Test consent flows and data sanitization regularly
- Monitor error rates and adjust sample rates accordingly

## Related Documentation

- [Privacy Policy](./PRIVACY.md)
- [Logging System](./logging/README.md) 
- [Analytics System](./analytics/README.md)
- [User Consent Management](./consent/README.md)