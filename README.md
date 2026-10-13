# QR BOX PAY

Responsive React + Vite starter for managing recipient profiles and generating PromptPay QR payloads. The supplied logo is included at `public/logo.jpeg`.

## Technology
- React 18 + Vite
- `qrcode` for PNG/SVG QR rendering
- IndexedDB in the current browser for durable local storage
- Vercel static hosting configuration (`vercel.json`)
- No Supabase, no admin panel, no product/cart/payment-status system

## Run locally

```bash
npm install
npm run dev
```

Production build:

```bash
npm run build
npm run preview
```

Deploy by importing this folder/repository into Vercel with the default Vite settings. Build command: `npm run build`; output directory: `dist`.

## Data storage and limits

Recipient records, saved QR records, and settings are written to IndexedDB. This survives ordinary refreshes and browser restarts on the same browser profile/device, but does **not** synchronize across devices. Clearing site data or losing the browser profile can remove the records. This starter does not connect to a cloud database or backend. A shared cross-device database/authentication service must be separately reviewed and approved before adding it. There is no automatic data reset or destructive migration.

## QR behavior and payment safety

- PromptPay phone numbers (10 digits beginning with 0) and Thai national/tax ID format (13 digits) are encoded into a PromptPay EMV-style payload with CRC16 and can be rendered as PNG/SVG.
- This code does not contact a bank or payment provider and cannot confirm that an account is active, belongs to the displayed person, or that payment has succeeded. Verify the QR with a banking app and perform real-world acceptance tests before production use.
- Bank account numbers and wallet IDs are stored as recipient references only. The app deliberately does not claim these identifiers alone can create a valid payment QR. Provider-specific certified QR formats/API/SDKs need to be verified and integrated before enabling them.
- No payment status is inferred from scanning, downloading, or saving a QR.
- Data is browser-local and there is no server-side access control because no server or multi-user service is included.

## Before production

1. Test generated payloads with official bank/provider test procedures and confirm compliance with the current Thai QR payment specification.
2. Add an approved backend/database and authentication only if cross-device sync or shared access is required.
3. Configure privacy, backup/export, retention, and access-control requirements for the approved storage design.
4. If integrating a provider, keep API secrets server-side and configure them as Vercel environment variables; never commit secrets.

This repository is a functional starter, not a claim of bank certification or verified live-payment processing.
