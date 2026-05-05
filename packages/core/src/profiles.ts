import type { SafetyProfileName } from "./types.js";

export const DEFAULT_DENY_PATTERNS = [
  ".env",
  ".env.*",
  "**/.env",
  "**/.env.*",
  "**/*.key",
  "**/*.pem",
  "**/*.p12",
  "**/*.pfx",
  "**/*secret*",
  "**/*token*",
  "**/*credential*",
  "**/*.sqlite",
  "**/*.sqlite3",
  "**/*.db",
  "**/*.db-*",
  "**/*.sqlite-*",
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/.git/**",
] as const;

export const SAFETY_PROFILE_DENY_PATTERNS: Record<SafetyProfileName, readonly string[]> = {
  generic: [],
  "mcp-oauth-service": [
    "**/oauth*.db",
    "**/*auth*.db",
    "**/*refresh*token*",
    "**/*signing*key*",
    "**/caddy/*.local*",
    "**/docker-compose.override.yml",
  ],
  "claude-hook-package": [
    ".claude/**",
    "**/.claude/**",
    "**/settings.json",
    "**/*transcript*",
  ],
  "markdown-memory-repo": [
    "**/private/**",
    "**/*private*.md",
    "**/.obsidian/workspace*",
  ],
  "python-mcp-service": [
    "**/__pycache__/**",
    "**/.venv/**",
    "**/venv/**",
  ],
  "node-mcp-service": [
    "**/node_modules/**",
    "**/.npmrc",
  ],
  "dockerized-public-endpoint": [
    "**/docker-compose.override.yml",
    "**/.docker/**",
    "**/caddy/*.local*",
    "**/Caddyfile.local",
  ],
};

export function getProfileDenyPatterns(profile: SafetyProfileName): string[] {
  return [...DEFAULT_DENY_PATTERNS, ...SAFETY_PROFILE_DENY_PATTERNS[profile]];
}
