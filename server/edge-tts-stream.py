import asyncio
import json
import sys

import edge_tts


async def main():
    request = json.loads(sys.stdin.buffer.read().decode('utf-8'))
    communicate = edge_tts.Communicate(
        request['text'],
        request['voice'],
        rate='-4%',
        pitch='-2Hz',
    )
    async for chunk in communicate.stream():
        if chunk.get('type') == 'audio' and chunk.get('data'):
            sys.stdout.buffer.write(chunk['data'])
            sys.stdout.buffer.flush()


asyncio.run(main())
