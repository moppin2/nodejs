const express = require('express');
const router = express.Router();
const { License } = require('../models');

router.get('/api/licenses', async (req, res) => {
    const { association } = req.query;
    const where = association ? { association } : {};
    const licenses = await License.findAll({
      where,
      order: [['sort_order', 'ASC']],
      attributes: ['id', 'name']
    });
    res.json(licenses);
  });

  module.exports = router;
