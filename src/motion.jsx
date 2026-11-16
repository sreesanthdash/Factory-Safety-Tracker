import { forwardRef } from "react";
import { motion, useReducedMotion } from "motion/react";
import { Link, NavLink } from "react-router-dom";

const AnimatedButton = motion.button;
const AnimatedLink = motion.create(Link);
const AnimatedNavLink = motion.create(NavLink);

export const MotionButton = forwardRef(function MotionButton({ whileHover, whileTap, transition, ...props }, ref) {
  const disabled = props.disabled;
  return <AnimatedButton ref={ref} whileHover={disabled ? undefined : (whileHover ?? { opacity: 0.97 })} whileTap={disabled ? undefined : (whileTap ?? { opacity: 0.92 })} transition={transition ?? { type: "tween", duration: 0.14, ease: "easeOut" }} {...props} />;
});

export const MotionLink = forwardRef(function MotionLink({ whileHover, whileTap, transition, ...props }, ref) {
  return <AnimatedLink ref={ref} whileHover={whileHover ?? { opacity: 0.97 }} whileTap={whileTap ?? { opacity: 0.92 }} transition={transition ?? { type: "tween", duration: 0.14, ease: "easeOut" }} {...props} />;
});

export const MotionNavLink = forwardRef(function MotionNavLink({ whileHover, whileTap, transition, ...props }, ref) {
  return <AnimatedNavLink ref={ref} whileHover={whileHover ?? { opacity: 0.94 }} whileTap={whileTap} transition={transition ?? { type: "tween", duration: 0.14, ease: "easeOut" }} {...props} />;
});

const AnimatedRow = motion.tr;
export function MotionRow(props) {
  return <AnimatedRow whileHover={{ opacity: 0.97 }} transition={{ type: "tween", duration: 0.12, ease: "easeOut" }} {...props} />;
}

const AnimatedLoadingMark = motion.span;
export function LoadingMark({ className = "loading-mark" }) {
  const prefersReducedMotion = useReducedMotion();
  return <AnimatedLoadingMark className={className} aria-hidden="true" animate={prefersReducedMotion ? { rotate: 0 } : { rotate: 360 }} transition={{ duration: 0.9, ease: "linear", repeat: prefersReducedMotion ? 0 : Infinity }} />;
}
