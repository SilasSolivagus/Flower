import path from 'node:path';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: path.join(process.cwd(), '../..'),
  transpilePackages: ['@flower/core'],
  serverExternalPackages: ['@node-rs/argon2'],
};

export default nextConfig;
