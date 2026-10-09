import type { Metadata } from 'next';
import { NewProjectFlow } from '@/components/NewProjectFlow';

export const metadata: Metadata = { title: 'New project' };
export default function NewProjectPage() { return <NewProjectFlow />; }
