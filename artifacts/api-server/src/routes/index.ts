import { Router, type IRouter } from "express";
import healthRouter from "./health";
import syncRouter from "./sync";
import ordersRouter, { publicOrdersRouter } from "./orders";
import { requireOperatorRole } from "../middlewares/auth";
import authRouter from "./auth";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(publicOrdersRouter);
router.use(requireOperatorRole);
router.use(syncRouter);
router.use(ordersRouter);

export default router;
