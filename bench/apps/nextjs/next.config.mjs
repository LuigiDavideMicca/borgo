/** @type {import('next').NextConfig} */
export default {
  // the load tool asks for identity encoding, and the other implementations do
  // not compress; leaving Next's gzip on would compare different bytes
  compress: false,
  poweredByHeader: false,
};
