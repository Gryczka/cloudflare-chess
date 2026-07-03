export type EngineEndState =
	| { ended: false }
	| { ended: true; result: '1-0' | '0-1' | '1/2-1/2'; reason: string };

export type ValidatedMove = {
	san: string;
	uci: string;
	fen: string;
	turn: 'w' | 'b';
	endState: EngineEndState;
};
