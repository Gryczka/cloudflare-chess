declare module 'cm-chessboard/src/Chessboard.js' {
	export const COLOR: { white: 'w'; black: 'b' };
	export const INPUT_EVENT_TYPE: {
		moveInputStarted: 'moveInputStarted';
		validateMoveInput: 'validateMoveInput';
		moveInputCanceled: 'moveInputCanceled';
		moveInputFinished: 'moveInputFinished';
	};
	export const BORDER_TYPE: { none: string; thin: string; frame: string };
	export const PIECES_FILE_TYPE: { svgSprite: string };
	export class Chessboard {
		constructor(context: HTMLElement, props?: Record<string, unknown>);
		setPosition(fen: string, animated?: boolean): Promise<void>;
		enableMoveInput(handler: (event: MoveInputEvent) => boolean | void, color?: 'w' | 'b'): void;
		disableMoveInput(): void;
	}
	export type MoveInputEvent = {
		type: string;
		squareFrom?: string;
		squareTo?: string;
	};
}
