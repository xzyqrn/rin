#!/bin/bash

# Load environment variables from parent directory .env file
export $(cat ../.env | grep -v '^#' | xargs)

echo "=== Starting Webview with Environment Variables ==="
echo "GOOGLE_CLIENT_ID: ${GOOGLE_CLIENT_ID:0:20}..."
echo "GOOGLE_CLIENT_SECRET: ${GOOGLE_CLIENT_SECRET:0:10}..."
echo "GOOGLE_OAUTH_BASE_URL: $GOOGLE_OAUTH_BASE_URL"
echo "NEXT_PUBLIC_BASE_URL: $NEXT_PUBLIC_BASE_URL"

# Start Next.js development server
npm run dev
