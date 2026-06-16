import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

export const metadata: Metadata = {
  title: 'CloudAgent API Reference / CloudAgent API 参考',
  description:
    'Native Scalar reference for the CloudAgent HTTP Run API. CloudAgent HTTP Run API 的原生 Scalar 参考文档。',
};

export default function CloudAgentAPIReferenceRedirect() {
  redirect('/reference/cloudagent');
}
