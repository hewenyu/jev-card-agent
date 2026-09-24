import type { IncomingMessage, ServerResponse } from 'node:http';

interface ScoreRequest {
  model: string;
  questions: Record<string, { type: string; criteria: string[] }>;
}

/** Local wire-format fixture; callers still exercise the production SDK HTTP adapter. */
export function scoreHttpFixture() {
  const calls: ScoreRequest[] = [];
  const handle = (request: IncomingMessage, response: ServerResponse): boolean => {
    if (request.url !== '/v1/systemone') return false;
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
    });
    request.on('end', () => {
      const input = JSON.parse(body) as ScoreRequest;
      calls.push(input);
      response.setHeader('Content-Type', 'application/json');
      response.end(
        JSON.stringify({
          model: input.model,
          answers: Object.fromEntries(
            Object.entries(input.questions).map(([id, question]) => {
              const selected = question.criteria.length - 1;
              return [
                id,
                {
                  type: 'score',
                  score: selected,
                  confidence: 1,
                  probabilities: Object.fromEntries(
                    question.criteria.map((_, index) => [index, index === selected ? 1 : 0]),
                  ),
                },
              ];
            }),
          ),
          usage: { input_tokens: 4, output_tokens: 2 },
        }),
      );
    });
    return true;
  };
  return { handle, calls };
}
