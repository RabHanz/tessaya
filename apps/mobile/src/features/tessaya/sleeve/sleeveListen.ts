// Talk's listening in the Sleeve, for its motion sensor: raised to him, she starts listening as if he tapped
let listen: (() => void) | null = null;
export const setSleeveListen = (start: (() => void) | null) => {
  listen = start;
};
export const sleeveListen = () => listen?.();
