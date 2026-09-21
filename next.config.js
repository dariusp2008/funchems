/** @type {import('next').NextConfig} */
const nextConfig = {
  async redirects() {
    return [
      { source: "/", destination: "/Morpheps.dc.html", permanent: false },
    ];
  },
};

module.exports = nextConfig;
