import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const docs = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/docs' }),
  schema: z.object({
    title: z.string(),
    order: z.number(),
    description: z.string().optional(),
    section: z.string().optional(),
    updated: z.string().optional(),
  }),
});

export const collections = { docs };