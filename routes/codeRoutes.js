const express = require('express');
const router = express.Router();
const { Code } = require('../models');

// 여러 그룹의 코드를 한 번에 조회
router.get('/api/codes/multiple', async (req, res) => {
  const groups = req.query.groups?.split(',') || [];

  if (groups.length === 0) {
    return res.status(400).json({ message: 'groups 파라미터가 필요합니다. 예: ?groups=LEVEL,REGION' });
  }

  const result = {};

  // 병렬 처리
  await Promise.all(groups.map(async (group) => {
    const codes = await Code.findAll({
      where: { group_code: group },
      order: [['sort_order', 'ASC']],
      attributes: ['code', 'name'],
    });
    result[group] = codes;
  }));

  res.json(result);
});

module.exports = router;
