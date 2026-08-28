import { Daytona } from '@veris-ai/daytona'
const d = new Daytona({ apiKey: process.env.DAYTONA_API_KEY })
for (const n of process.argv.slice(2)) {
  await d.snapshot.delete(n).then(() => console.log('deleted', n)).catch((e: any) => console.log('skip', n, e?.message?.slice(0,80)))
}
