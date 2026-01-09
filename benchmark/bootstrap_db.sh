#!/bin/bash

# Bootstrap a local PostgreSQL database for benchmarking
# Usage: ./benchmark/bootstrap_db.sh

set -e

CONTAINER_NAME="stripe-no-webhooks-benchmark"
POSTGRES_USER="postgres"
POSTGRES_PASSWORD="postgres"
POSTGRES_DB="stripe_benchmark"
POSTGRES_PORT="5433"  # Use non-default port to avoid conflicts

echo "🐘 Setting up PostgreSQL for benchmarking..."

# Check if Docker is running
if ! docker info > /dev/null 2>&1; then
    echo "❌ Docker is not running. Please start Docker and try again."
    exit 1
fi

# Check if container already exists
if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    # Check if it's running
    if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
        echo "✅ Container '${CONTAINER_NAME}' is already running."
    else
        echo "🔄 Starting existing container '${CONTAINER_NAME}'..."
        docker start ${CONTAINER_NAME}
    fi
else
    echo "📦 Creating new PostgreSQL container..."
    docker run -d \
        --name ${CONTAINER_NAME} \
        -e POSTGRES_USER=${POSTGRES_USER} \
        -e POSTGRES_PASSWORD=${POSTGRES_PASSWORD} \
        -e POSTGRES_DB=${POSTGRES_DB} \
        -p ${POSTGRES_PORT}:5432 \
        postgres:16-alpine

    echo "⏳ Waiting for PostgreSQL to be ready..."
    sleep 3

    # Wait for postgres to be ready
    for i in {1..30}; do
        if docker exec ${CONTAINER_NAME} pg_isready -U ${POSTGRES_USER} > /dev/null 2>&1; then
            break
        fi
        sleep 1
    done
fi

# Verify connection
if ! docker exec ${CONTAINER_NAME} pg_isready -U ${POSTGRES_USER} > /dev/null 2>&1; then
    echo "❌ PostgreSQL is not ready. Please check the container logs:"
    echo "   docker logs ${CONTAINER_NAME}"
    exit 1
fi

CONNECTION_STRING="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@localhost:${POSTGRES_PORT}/${POSTGRES_DB}"

echo ""
echo "✅ PostgreSQL is ready!"
echo ""
echo "📋 Connection string:"
echo "   ${CONNECTION_STRING}"
echo ""
echo "🚀 Next steps:"
echo ""
echo "   1. Run migrations:"
echo "      DATABASE_URL=\"${CONNECTION_STRING}\" npx stripe-no-webhooks migrate"
echo ""
echo "   2. Backfill data from Stripe:"
echo "      DATABASE_URL=\"${CONNECTION_STRING}\" STRIPE_SECRET_KEY=sk_test_... npx stripe-no-webhooks backfill"
echo ""
echo "   3. Run the benchmark:"
echo "      DATABASE_URL=\"${CONNECTION_STRING}\" STRIPE_SECRET_KEY=sk_test_... npx tsx benchmark/fasterStripe.ts"
echo ""
echo "🛑 To stop the database:"
echo "   docker stop ${CONTAINER_NAME}"
echo ""
echo "🗑️  To remove the database:"
echo "   docker rm -f ${CONTAINER_NAME}"
echo ""
