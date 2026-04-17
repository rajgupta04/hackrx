# HackRx UI Showcase

A lightweight interview-ready frontend for the HackRx RAG API.

## Features

- PDF URL and PDF file upload support
- Multi-question query builder
- Pipeline status display (preprocess -> ask)
- Result cards with answer/source metadata
- Local run history for instant replay
- Dark/light presentation mode

## Local Setup

1. Install dependencies:

```bash
npm install
```

2. Create local env:

```bash
cp .env.example .env
```

3. Ensure backend API is running (`hackrx/main.py`) and update `VITE_API_BASE_URL` if needed.

4. Start dev server:

```bash
npm run dev
```

## Build

```bash
npm run build
npm run preview
```

## Expected Backend Endpoints

- `GET /`
- `POST /hackrx/preprocess`
- `POST /hackrx/preprocess-upload`
- `POST /hackrx/ask`
- `POST /hackrx/run` (legacy combined endpoint)
