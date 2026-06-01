#!/bin/bash

# Exit on error
set -e

echo "================================================================="
echo "⚡  CURRICULUM COMPLIANCE PIPELINE: ON-DEMAND VERIFICATION  ⚡"
echo "================================================================="
echo ""

# 1. Check for .env file
if [ ! -f .env ]; then
  echo "❌ Error: .env file not found in the project root."
  echo "   Please create it based on the template."
  exit 1
fi

# 2. Check if Node.js is installed
if ! command -v node &> /dev/null; then
  echo "❌ Error: Node.js is not installed or not in PATH."
  exit 1
fi

echo "📦 Step 1/4: Checking and installing project dependencies..."
npm install --quiet
echo "✔ Dependencies checked."
echo ""

echo "🔍 Step 2/4: Running TypeScript type-checking..."
npm run lint
echo "✔ Code matches type requirements."
echo ""

echo "🧪 Step 3/4: Running unit tests..."
npm run test
echo "✔ Unit tests passed."
echo ""

echo "🤖 Step 4/4: Launching Multi-Agent Evaluation Harness..."
echo "   (This will trace agent behaviors directly to Langsmith)"
npm run test:harness
echo ""

echo "================================================================="
echo "✅  SYSTEM VERIFICATION SUCCESSFUL: PIPELINE & PDF CONFORMS"
echo "================================================================="
exit 0
