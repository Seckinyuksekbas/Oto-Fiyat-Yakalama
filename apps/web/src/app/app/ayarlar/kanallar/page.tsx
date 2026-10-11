import type { Metadata } from 'next';
import { ChannelsView } from './channels-view';

export const metadata: Metadata = { title: 'Bildirim kanalları' };

export default function ChannelsPage() {
  return <ChannelsView />;
}
