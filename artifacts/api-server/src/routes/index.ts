import { Router, type IRouter } from "express";
import healthRouter from "./health";
import pushRouter from "./push";
import adminRouter from "./admin";
import shopifyRouter from "./shopify";
import agoraRouter from "./agora";
import chatRouter from "./chat";
import dealRouter from "./deal";
import hiddenJestRouter from "./hiddenJest";
import suitsRouter from "./suits";
import auditRouter from "./audit";

const router: IRouter = Router();

router.use(healthRouter);
router.use(pushRouter);
router.use(adminRouter);
router.use(shopifyRouter);
router.use(agoraRouter);
router.use(chatRouter);
router.use(dealRouter);
router.use(hiddenJestRouter);
router.use(suitsRouter);
router.use(auditRouter);

export default router;
