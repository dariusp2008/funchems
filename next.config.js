/** @type {import('next').NextConfig} */
const nextConfig = {
  async redirects() {
    return [
      { source: "/", destination: "/Funchems.dc.html", permanent: false },
    ];
  },
};

module.exports = nextConfig;
