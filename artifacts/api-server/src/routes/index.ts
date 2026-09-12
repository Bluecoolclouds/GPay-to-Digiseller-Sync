import { Router, type IRouter } from "express";
import healthRouter from "./health";
import syncRouter from "./sync";
import ordersRouter from "./orders";
import { requireOperatorRole } from "../middlewares/auth";

const router: IRouter = Router();

router.use(healthRouter);
router.use(requireOperatorRole);
router.use(syncRouter);
router.use(ordersRouter);

export default router;
