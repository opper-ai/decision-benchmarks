/** What the server signs for each model answer (and the high-score check verifies): junction, ghost, direction, model. */
export const answerMessage = (key: string, question: string, choice: string, model: string): string => `answer|${key}|${question}|${choice}|${model}`;
