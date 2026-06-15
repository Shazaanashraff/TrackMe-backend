# Phase A .env.example Templates (Docs Only)

These templates list required keys. Final values are provided by the owner.

## backend/.env.example
```text
PORT=5000
MONGODB_URI=
MONGODB_TEST_URI=
JWT_SECRET=
JWT_EXPIRES_IN=
REFRESH_TOKEN_SECRET=
REFRESH_TOKEN_EXPIRES_IN=
GOOGLE_CLIENT_ID=
EMAIL_FROM=
RESEND_API_KEY=
CLIENT_ORIGINS=
```

## user-app/.env.example
```text
EXPO_PUBLIC_API_URL=
EXPO_PUBLIC_SOCKET_URL=
EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID=
EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID=
EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID=
```

## driver-app/.env.example
```text
EXPO_PUBLIC_API_URL=
EXPO_PUBLIC_SOCKET_URL=
```

## web-admin/.env.example
```text
VITE_API_URL=
```

## Notes
- Keep examples synced with src/config.js and any auth providers.
- Do not commit real credentials.
