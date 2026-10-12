/**
 * What the server signs for each model answer, and what a game's high-score check verifies: the question's key (a
 * junction, a turn, a step), the question's name in the request, the choice and the model. The signing key is per game
 * (packages/kit/server/answers.ts), so an answer signed for one game never verifies in another.
 */
export const answerMessage = (key: string, question: string, choice: string, model: string): string => `answer|${key}|${question}|${choice}|${model}`;
