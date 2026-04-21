#!/bin/zsh
# bitbucket-api-key-test.sh

# Usage: ./bitbucket-api-key-test.sh <api_key>
# Tests Bitbucket API key (Bearer token) by fetching repo list

if [[ "$1" == "-h" || "$1" == "--help" || "$#" -ne 1 ]]; then
  echo "Usage: $0 <api_key>"
  echo "Example: $0 xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
  exit 1
fi

API_KEY="$1"
API_URL="https://api.bitbucket.org/2.0/repositories/bdbi?pagelen=1"
echo "Testing Bitbucket API key (Bearer token)"

HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $API_KEY" "$API_URL")

if [[ "$HTTP_STATUS" == "200" ]]; then
  echo "✅ Success: API key is valid."
  exit 0
else
  echo "❌ Failed: API key is invalid or lacks permissions. HTTP status: $HTTP_STATUS"
  exit 2
fi


