# Tinzel Backend

RESTful backend service for Tinzel built with Node.js, Express, and MongoDB.

## Features

- **Express.js API Architecture**: Clean separation of routes, controllers, and models.
- **MongoDB & Mongoose**: Database integration with graceful fallback mode.
- **Health Diagnostics**: Real-time status at `/api/health`.
- **CORS Configured**: Ready for frontend integration.
- **Environment Driven**: Configurable via `.env`.

## Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/` | API status index |
| `GET` | `/api/health` | Service health & MongoDB status |
| `GET` | `/api/items` | List items (MongoDB or in-memory fallback) |
| `POST` | `/api/items` | Create new item |
| `DELETE` | `/api/items/:id` | Delete an item |

## Getting Started

### 1. Install dependencies
```bash
npm install
```

### 2. Environment variables
Copy `.env.example` to `.env` and update values if needed:
```bash
cp .env.example .env
```

### 3. Run the server
- Development mode (with nodemon):
```bash
npm run dev
```

- Production mode:
```bash
npm start
```
