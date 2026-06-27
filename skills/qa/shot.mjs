// Upload a QA screenshot to the private bevyl-github-media S3 bucket and print a URL to link/embed in a GitHub
// PR comment as proof. Recreates the old qa upload-screenshot mechanism. Self-contained: signs the S3 PUT with
// SigV4 (node:crypto + fetch), no AWS SDK / CLI needed. Creds from the env (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY).
//
//   bun .codex/skills/qa/shot.mjs <file.png> [name]        -> prints the URL
//   gh pr comment <N> --body "QA proof: ![fixed](<url>)"   -> embeds it in the PR
import { readFileSync } from 'node:fs'
import { createHash, createHmac } from 'node:crypto'
import { basename } from 'node:path'

const BUCKET = 'bevyl-github-media'
const REGION = 'us-east-1' // the bucket's region (fixed)
const AK = process.env.AWS_ACCESS_KEY_ID
const SK = process.env.AWS_SECRET_ACCESS_KEY
const ST = process.env.AWS_SESSION_TOKEN

const [file, name] = process.argv.slice(2)
if (!file) { console.error('usage: bun shot.mjs <file.png> [name]'); process.exit(2) }
if (!AK || !SK) { console.error('AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY not set'); process.exit(1) }

const body = readFileSync(file)
const slug = (name || basename(file).replace(/\.png$/i, '')).replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 80)
const key = `qa-screenshots/${slug}-${Date.now()}.png`
const host = `${BUCKET}.s3.amazonaws.com`

const amzdate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '') // YYYYMMDDTHHMMSSZ
const datestamp = amzdate.slice(0, 8)
const payloadHash = createHash('sha256').update(body).digest('hex')
const signed = `host;x-amz-content-sha256;x-amz-date${ST ? ';x-amz-security-token' : ''}`
const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzdate}\n${ST ? `x-amz-security-token:${ST}\n` : ''}`
const canonicalRequest = `PUT\n/${key}\n\n${canonicalHeaders}\n${signed}\n${payloadHash}`
const scope = `${datestamp}/${REGION}/s3/aws4_request`
const stringToSign = `AWS4-HMAC-SHA256\n${amzdate}\n${scope}\n${createHash('sha256').update(canonicalRequest).digest('hex')}`
const hmac = (k, d) => createHmac('sha256', k).update(d).digest()
const kSigning = hmac(hmac(hmac(hmac(`AWS4${SK}`, datestamp), REGION), 's3'), 'aws4_request')
const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex')

const res = await fetch(`https://${host}/${key}`, {
  method: 'PUT',
  headers: {
    'x-amz-date': amzdate,
    'x-amz-content-sha256': payloadHash,
    authorization: `AWS4-HMAC-SHA256 Credential=${AK}/${scope}, SignedHeaders=${signed}, Signature=${signature}`,
    'content-type': 'image/png',
    ...(ST ? { 'x-amz-security-token': ST } : {}),
  },
  body,
})
if (res.ok) console.log(`https://${host}/${key}`)
else { console.error('upload failed:', res.status, (await res.text()).slice(0, 300)); process.exit(1) }
