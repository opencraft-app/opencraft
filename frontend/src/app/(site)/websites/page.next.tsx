'use client';

import { useEffect } from 'react';

export default function WebsitesPage() {
  useEffect(() => {
    window.location.replace('/agents/websites/');
  }, []);

  return null;
}
